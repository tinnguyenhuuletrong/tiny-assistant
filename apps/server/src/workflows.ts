/**
 * Workflows as pi-durable tasks. A run is one task owned by its session's conversation. Its single phase calls the
 * workflow's `run()`; every `step()` result is memoized in the task record (`runtime.memo`), so after a crash or a
 * restart the phase runs again from the top and finished steps return their stored values instead of running again.
 * Agent steps submit an input to the session with a request ID derived from the run and step, so a rerun finds the same
 * submission instead of asking twice. Stopping the session aborts the run.
 */
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	defineEntry,
	defineExtension,
	defineTask,
	type Extension,
	type RunningTask,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { compile } from "@earendil-works/pi-schema";
import type { ExecResult, WorkflowContext, WorkflowDefinition } from "@tiny/core/define";
import {
	ENTRY_KINDS,
	type WorkflowFinishedData,
	type WorkflowInfo,
	type WorkflowLogData,
	type WorkflowStartedData,
	type WorkflowStepData,
} from "@tiny/core/protocol";

export const WorkflowStarted = defineEntry<WorkflowStartedData & { input: JsonValue }>(ENTRY_KINDS.workflowStarted);
export const WorkflowStep = defineEntry<WorkflowStepData>(ENTRY_KINDS.workflowStep);
export const WorkflowLog = defineEntry<WorkflowLogData>(ENTRY_KINDS.workflowLog);
export const WorkflowFinished = defineEntry<WorkflowFinishedData & { result?: JsonValue }>(
	ENTRY_KINDS.workflowFinished,
);

type RunInput = { name: string; input: JsonValue };
type RunState = { phase: "run" };
type Runtime = TaskRuntime<RunInput, RunState, JsonValue, object>;

/** The live set of workflow definitions, replaced as files change. */
export class WorkflowCatalog {
	readonly #defs = new Map<string, { def: WorkflowDefinition<unknown>; source: string }>();

	set(def: WorkflowDefinition<unknown>, source: string): void {
		this.#defs.set(def.name, { def, source });
	}

	removeSource(source: string): void {
		for (const [name, entry] of this.#defs) if (entry.source === source) this.#defs.delete(name);
	}

	get(name: string): WorkflowDefinition<unknown> | undefined {
		return this.#defs.get(name)?.def;
	}

	list(): WorkflowInfo[] {
		return [...this.#defs.values()]
			.map(({ def, source }) => ({
				name: def.name,
				description: def.description,
				input: def.input === undefined ? undefined : JSON.parse(JSON.stringify(def.input)),
				source,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Validate (and coerce) a run's input against the workflow's schema. */
	validate(name: string, input: unknown): JsonValue {
		const def = this.get(name);
		if (!def) throw new Error(`Unknown workflow "${name}"`);
		if (def.input === undefined) return (input ?? null) as JsonValue;
		const result = compile(def.input as never, { coerce: true }).parse(input ?? {});
		if (!result.ok) {
			const detail = result.errors.map((error) => `${error.path || "input"}: ${error.message}`).join("; ");
			throw new Error(`Invalid input for ${name}: ${detail}`);
		}
		return result.value as JsonValue;
	}
}

async function appendEntry(
	runtime: Runtime,
	draft: { kind: string; data: JsonValue },
	context: Context,
): Promise<void> {
	await runtime.commit(async (tx) => {
		await tx.appendEntry(runtime.conversationId, draft);
		return undefined;
	}, context);
}

function textOfEntry(entry: { model?: readonly unknown[] } | undefined): string {
	const message = entry?.model?.[0] as { content?: unknown } | undefined;
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => (part as { type?: string }).type === "text")
		.map((part) => part.text)
		.join("");
}

async function runCommand(command: string, cwd: string | undefined, timeoutMs: number, signal: AbortSignal) {
	const child = Bun.spawn(["bash", "-lc", command], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const output = `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
	const MAX = 64 * 1024;
	return { exitCode, output: output.length > MAX ? `…${output.slice(-MAX)}` : output };
}

function createContext(
	task: RunningTask<RunInput, RunState, JsonValue>,
	runtime: Runtime,
	context: Context,
	cwd: string | undefined,
): WorkflowContext<unknown> {
	const runId = Number(task.id);
	const used = new Set<string>();
	const counters = { agent: 0, exec: 0 };

	const step = async <T extends JsonValue>(name: string, fn: () => Promise<T> | T): Promise<T> => {
		if (used.has(name)) throw new Error(`Workflow step "${name}" used twice in one run; step names must be unique`);
		used.add(name);
		const key = `step:${name}`;
		const stored = await runtime.memo<{ value: T }>(key, context);
		if (stored !== undefined) return stored.value;
		try {
			const value = ((await fn()) ?? null) as T;
			const kept = await runtime.memo<{ value: T }>(key, { value } as { value: T }, context);
			await appendEntry(
				runtime,
				{ kind: WorkflowStep.kind, data: { runId, step: name, status: "done" } satisfies WorkflowStepData },
				context,
			);
			return kept.value;
		} catch (error) {
			await appendEntry(
				runtime,
				{
					kind: WorkflowStep.kind,
					data: {
						runId,
						step: name,
						status: "failed",
						summary: String(error).slice(0, 500),
					} satisfies WorkflowStepData,
				},
				context,
			);
			throw error;
		}
	};

	return {
		input: task.input.input,
		sessionId: Number(runtime.conversationId),
		cwd,
		signal: runtime.signal,
		step,
		async agent(prompt, options) {
			const name = options?.step ?? `agent:${++counters.agent}`;
			return step(name, async () => {
				const handle = await runtime.conversation(runtime.conversationId, context);
				if (!handle) throw new Error("The workflow's session is gone");
				const submission = await handle.submit(
					{ type: "input", content: prompt, requestId: `workflow:${runId}:${name}` },
					context,
				);
				const settled = await submission.wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					const reason = "reason" in settled ? String(settled.reason) : settled.status;
					throw new Error(`Agent step "${name}" was not answered (${reason})`);
				}
				return textOfEntry(await runtime.entry(settled.answer, context));
			});
		},
		async exec(command, options) {
			const name = options?.step ?? `exec:${++counters.exec}`;
			return step(name, async () => {
				const result = await runCommand(
					command,
					options?.cwd ?? cwd,
					options?.timeoutMs ?? 10 * 60_000,
					runtime.signal,
				);
				return result satisfies ExecResult as unknown as JsonValue;
			}) as unknown as Promise<ExecResult>;
		},
		async log(text, level = "info") {
			await appendEntry(
				runtime,
				{ kind: WorkflowLog.kind, data: { runId, text, level } satisfies WorkflowLogData },
				context,
			);
		},
	};
}

export function createWorkflowTask(catalog: WorkflowCatalog, cwdOf: (sessionId: number) => string | undefined) {
	const finish = async (
		task: RunningTask<RunInput, RunState, JsonValue>,
		runtime: Runtime,
		context: Context,
		outcome: { status: "completed"; result: JsonValue } | { status: "failed"; error: string } | { status: "aborted" },
	) => {
		const data: WorkflowFinishedData = {
			runId: Number(task.id),
			name: task.input.name,
			status: outcome.status,
			...(outcome.status === "completed" ? { result: outcome.result } : {}),
			...(outcome.status === "failed" ? { error: outcome.error } : {}),
		};
		await runtime.commit(async (tx) => {
			await tx.appendEntry(runtime.conversationId, { kind: WorkflowFinished.kind, data: data as JsonValue });
			if (outcome.status === "completed") {
				return { status: "terminal", outcome: { status: "completed", result: outcome.result } };
			}
			if (outcome.status === "failed") {
				return { status: "terminal", outcome: { status: "failed", error: { message: outcome.error } } };
			}
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	};

	return defineTask<RunInput, RunState, JsonValue>({
		name: "tiny.workflow",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				const def = catalog.get(task.input.name);
				if (!def) {
					await finish(task, runtime, context, {
						status: "failed",
						error: `Workflow "${task.input.name}" is not installed`,
					});
					return;
				}
				const ctx = createContext(task, runtime, context, cwdOf(Number(runtime.conversationId)));
				let result: JsonValue;
				try {
					const value = await def.run(ctx);
					result = value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
				} catch (error) {
					if (runtime.signal.aborted) throw error; // the abort handler records the outcome
					await finish(task, runtime, context, {
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
				await finish(task, runtime, context, { status: "completed", result });
			},
		},
		abort: async (task, runtime, context) => {
			await finish(task, runtime, context, { status: "aborted" });
		},
	});
}

export type WorkflowTaskDef = ReturnType<typeof createWorkflowTask>;

export function createWorkflowExtension(task: WorkflowTaskDef): Extension {
	return defineExtension({ name: "tiny-workflows", tasks: [task] });
}
