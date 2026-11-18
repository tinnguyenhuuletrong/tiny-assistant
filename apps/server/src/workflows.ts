/**
 * Workflows as pi-durable tasks. A run is one task owned by its session's conversation.
 *
 * - `run` phase: calls the workflow's `run()`. Every `step()` result is memoized in the task record (`runtime.memo`),
 *   so after a crash or restart the phase runs again from the top and finished steps return their stored values.
 *   Agent steps submit to the session with a request ID derived from the run and step, so a rerun finds the same
 *   submission instead of asking twice.
 * - `rollback` phase (a saga): when `run()` throws, the task commits a move to `rollback`, so a crash during the
 *   rollback resumes the rollback. It replays `run()` with the stored step results to find the finished steps and
 *   their `undo` callbacks (replay stops at the first step that never finished), then runs the undos newest first.
 *   Each undo is memoized (`undo:<step>`), so none runs twice.
 * - Stopping the session aborts the task; its abort handler runs the same rollback, then ends `aborted`.
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
import type { ExecResult, StepOptions, WorkflowContext, WorkflowDefinition } from "@tiny/core/define";
import {
	ENTRY_KINDS,
	type WorkflowFinishedData,
	type WorkflowInfo,
	type WorkflowLogData,
	type WorkflowRollbackData,
	type WorkflowStartedData,
	type WorkflowStepData,
} from "@tiny/core/protocol";

export const WorkflowStarted = defineEntry<WorkflowStartedData & { input: JsonValue }>(ENTRY_KINDS.workflowStarted);
export const WorkflowStep = defineEntry<WorkflowStepData>(ENTRY_KINDS.workflowStep);
export const WorkflowLog = defineEntry<WorkflowLogData>(ENTRY_KINDS.workflowLog);
export const WorkflowRollback = defineEntry<WorkflowRollbackData>(ENTRY_KINDS.workflowRollback);
export const WorkflowFinished = defineEntry<WorkflowFinishedData & { result?: JsonValue }>(
	ENTRY_KINDS.workflowFinished,
);

type RunInput = { name: string; input: JsonValue };
type RunState = { phase: "run" } | { phase: "rollback"; error: string };
type Runtime = TaskRuntime<RunInput, RunState, JsonValue, object>;
type Task = RunningTask<RunInput, RunState, JsonValue>;

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

function stepEntry(runtime: Runtime, data: WorkflowStepData, context: Context): Promise<void> {
	return appendEntry(runtime, { kind: WorkflowStep.kind, data: data as unknown as JsonValue }, context);
}

function textOfEntry(entry: { model?: readonly unknown[] } | undefined): string {
	const message = entry?.model?.[0] as { content?: unknown } | undefined;
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => (part as { type?: string }).type === "text")
		.map((part) => part.text)
		.join("");
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

/** Thrown in replay mode at the first step that has no stored result: everything before it finished. */
class ReplayStop extends Error {
	constructor() {
		super("replay stopped at an unfinished step");
	}
}

type Finished = { name: string; value: JsonValue; undo: (value: JsonValue) => Promise<void> | void };

/**
 * The context `run()` sees. In replay mode (used by rollbacks) steps only return stored results and collect their
 * undo callbacks; nothing runs and nothing is logged.
 */
function createContext(
	task: Task,
	runtime: Runtime,
	context: Context,
	cwd: string | undefined,
	mode: { replay: false } | { replay: true; finished: Finished[] },
): WorkflowContext<unknown> {
	const runId = Number(task.id);
	const used = new Set<string>();
	const counters = { agent: 0, exec: 0 };
	let stopped = false;

	const step = async <T extends JsonValue>(
		name: string,
		fn: () => Promise<T> | T,
		options?: StepOptions<T>,
	): Promise<T> => {
		if (used.has(name)) throw new Error(`Workflow step "${name}" used twice in one run; step names must be unique`);
		used.add(name);
		const key = `step:${name}`;
		if (mode.replay && stopped) throw new ReplayStop();
		const stored = await runtime.memo<{ value: T }>(key, context);
		if (stored !== undefined) {
			if (mode.replay && options?.undo) {
				mode.finished.push({ name, value: stored.value, undo: options.undo as Finished["undo"] });
			}
			return stored.value;
		}
		if (mode.replay) {
			stopped = true;
			throw new ReplayStop();
		}
		await stepEntry(runtime, { runId, step: name, status: "running" }, context);
		try {
			const value = ((await fn()) ?? null) as T;
			const kept = await runtime.memo<{ value: T }>(key, { value } as { value: T }, context);
			await stepEntry(runtime, { runId, step: name, status: "done" }, context);
			return kept.value;
		} catch (error) {
			await stepEntry(
				runtime,
				{ runId, step: name, status: "failed", summary: messageOf(error).slice(0, 500) },
				context,
			);
			throw error;
		}
	};

	return {
		input: task.input.input,
		runId,
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
			const directory = options?.cwd ?? cwd;
			const undoCommand = options?.undo;
			const undo = undoCommand
				? async () => {
						const reverted = await runCommand(
							undoCommand,
							directory,
							options?.timeoutMs ?? 10 * 60_000,
							runtime.signal,
						);
						if (reverted.exitCode !== 0)
							throw new Error(`undo exited ${reverted.exitCode}: ${reverted.output.slice(-300)}`);
					}
				: undefined;
			return step(
				name,
				async () => {
					const result = await runCommand(command, directory, options?.timeoutMs ?? 10 * 60_000, runtime.signal);
					if (options?.check && result.exitCode !== 0) {
						const tail = result.output.trim().split("\n").slice(-5).join("\n");
						throw new Error(`\`${command}\` exited ${result.exitCode}${tail ? `: ${tail}` : ""}`);
					}
					return result satisfies ExecResult as unknown as JsonValue;
				},
				undo ? { undo } : undefined,
			) as unknown as Promise<ExecResult>;
		},
		async log(text, level = "info") {
			if (mode.replay) return;
			await appendEntry(
				runtime,
				{ kind: WorkflowLog.kind, data: { runId, text, level } satisfies WorkflowLogData },
				context,
			);
		},
	};
}

/**
 * Revert the finished steps of a run, newest first. Safe to call again after a crash: undos that already ran are
 * memoized and skipped. Returns the steps reverted and the undo failures.
 */
async function rollback(
	def: WorkflowDefinition<unknown> | undefined,
	task: Task,
	runtime: Runtime,
	context: Context,
	cwd: string | undefined,
): Promise<{ undone: string[]; failures: string[] }> {
	if (!def) return { undone: [], failures: ["the workflow is no longer installed, so its steps cannot be undone"] };
	const finished: Finished[] = [];
	try {
		await def.run(createContext(task, runtime, context, cwd, { replay: true, finished }));
	} catch {
		// ReplayStop at the step that never finished, or the run's own error: either way `finished` is complete.
	}
	const runId = Number(task.id);
	const undone: string[] = [];
	const failures: string[] = [];
	for (const step of finished.reverse()) {
		const key = `undo:${step.name}`;
		if ((await runtime.memo<boolean>(key, context)) !== undefined) {
			undone.push(step.name);
			continue;
		}
		await stepEntry(runtime, { runId, step: step.name, status: "undoing" }, context);
		try {
			await step.undo(step.value);
			await runtime.memo(key, true, context);
			await stepEntry(runtime, { runId, step: step.name, status: "undone" }, context);
			undone.push(step.name);
		} catch (error) {
			const message = messageOf(error).slice(0, 500);
			await stepEntry(runtime, { runId, step: step.name, status: "undo_failed", summary: message }, context);
			failures.push(`${step.name}: ${message}`);
		}
	}
	return { undone, failures };
}

type Outcome =
	| { status: "completed"; result: JsonValue }
	| { status: "failed"; error: string; rolledBack?: string[] }
	| { status: "aborted"; rolledBack?: string[] };

export function createWorkflowTask(catalog: WorkflowCatalog, cwdOf: (sessionId: number) => string | undefined) {
	const finish = async (task: Task, runtime: Runtime, context: Context, outcome: Outcome) => {
		const data: WorkflowFinishedData = {
			runId: Number(task.id),
			name: task.input.name,
			status: outcome.status,
			...(outcome.status === "completed" ? { result: outcome.result } : {}),
			...(outcome.status === "failed" ? { error: outcome.error } : {}),
			...(outcome.status !== "completed" && outcome.rolledBack?.length ? { rolledBack: outcome.rolledBack } : {}),
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

	const revert = async (task: Task, runtime: Runtime, context: Context, reason: string) => {
		const def = catalog.get(task.input.name);
		await appendEntry(
			runtime,
			{ kind: WorkflowRollback.kind, data: { runId: Number(task.id), reason } satisfies WorkflowRollbackData },
			context,
		);
		return rollback(def, task, runtime, context, cwdOf(Number(runtime.conversationId)));
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
				const ctx = createContext(task, runtime, context, cwdOf(Number(runtime.conversationId)), { replay: false });
				let result: JsonValue;
				try {
					const value = await def.run(ctx);
					result = value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
				} catch (error) {
					if (runtime.signal.aborted) throw error; // the abort handler rolls back and records the outcome
					// Durably move to the rollback phase, so a crash during it resumes the rollback.
					await runtime.commit(
						() => ({ status: "running", checkpoint: { phase: "rollback", error: messageOf(error) } }),
						context,
					);
					return;
				}
				await finish(task, runtime, context, { status: "completed", result });
			},
			rollback: async (task, runtime, context) => {
				const { error } = task.state.checkpoint;
				const { undone, failures } = await revert(task, runtime, context, error);
				const note = failures.length > 0 ? ` (rollback incomplete: ${failures.join("; ")})` : "";
				await finish(task, runtime, context, { status: "failed", error: `${error}${note}`, rolledBack: undone });
			},
		},
		abort: async (task, runtime, context) => {
			const { undone } = await revert(task, runtime, context, "stopped");
			await finish(task, runtime, context, { status: "aborted", rolledBack: undone });
		},
	});
}

export type WorkflowTaskDef = ReturnType<typeof createWorkflowTask>;

export function createWorkflowExtension(task: WorkflowTaskDef): Extension {
	return defineExtension({ name: "tiny-workflows", tasks: [task] });
}
