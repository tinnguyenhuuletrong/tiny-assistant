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
 * - Human in the loop: `ask()` parks the run. In one commit it writes the question to the session and creates a small
 *   owned "question" task that just sleeps, and the run waits on it (no process held). Answering stores the answer in
 *   the session's answers document and aborts the question task, which wakes the run; `run()` replays to the `ask`,
 *   which now returns the answer. A question task that ends on its own means its deadline passed.
 */
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	defineDoc,
	defineEntry,
	defineExtension,
	defineTask,
	type Extension,
	type RunningTask,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { compile } from "@earendil-works/pi-schema";
import type { AskOptions, ExecResult, StepOptions, WorkflowContext, WorkflowDefinition } from "@tiny/core/define";
import {
	ENTRY_KINDS,
	type WorkflowAskData,
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
export const WorkflowAsk = defineEntry<WorkflowAskData>(ENTRY_KINDS.workflowAsk);

/** Answers to workflow questions in a session, by `<runId>:<key>`. First answer wins. */
export const AnswersDoc = defineDoc<{ answers: Record<string, string> }>({
	kind: "tiny.workflow.answers",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ answers: {} }),
	checkpointWhen: () => false,
});

/** Per run: the question task created for each `ask` key, so a woken run can tell "answered" from "expired". */
const QuestionsDoc = defineDoc<{ questions: Record<string, number> }>({
	kind: "tiny.workflow.questions",
	version: 1,
	scope: "task",
	initial: () => ({ questions: {} }),
	checkpointWhen: () => false,
});

/** Longest single sleep; a question without a deadline sleeps again after it. Keeps timers well inside 2^31 ms. */
const MAX_SLEEP_MS = 7 * 24 * 60 * 60 * 1000;

type QuestionInput = { runId: number; key: string; deadline: number | null };
type QuestionState = { phase: "wait" } | { phase: "check" };

/**
 * Holds a run's place while it waits for an answer: it only sleeps. Ending it early (abort) is how an answer, or a
 * Stop, wakes the run; ending on its own means the deadline passed.
 */
export const QuestionTask = defineTask<QuestionInput, QuestionState, { expired: true }>({
	name: "tiny.workflow.question",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (task, runtime, context) =>
			runtime.sleepUntil(
				Math.min(task.input.deadline ?? Number.POSITIVE_INFINITY, runtime.now() + MAX_SLEEP_MS),
				{ phase: "check" },
				context,
			),
		check: async (task, runtime, context) => {
			const expired = task.input.deadline !== null && runtime.now() >= task.input.deadline;
			await runtime.commit(
				() =>
					expired
						? { status: "terminal", outcome: { status: "completed", result: { expired: true } } }
						: { status: "running", checkpoint: { phase: "wait" } },
				context,
			);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export type QuestionHooks = {
	/** A run started (or stopped) waiting for an answer. */
	waiting(sessionId: number, runId: number, key: string, open: boolean): void;
};

type RunInput = { name: string; input: JsonValue };
type RunState = { phase: "run" } | { phase: "rollback"; error: string };
type Runtime = TaskRuntime<RunInput, RunState, JsonValue, object>;
type Task = RunningTask<RunInput, RunState, JsonValue>;

/** The live set of workflow definitions, replaced as files change. */
export class WorkflowCatalog {
	readonly #defs = new Map<string, { def: WorkflowDefinition<unknown>; source: string }>();

	set(def: WorkflowDefinition<unknown>, source: string): void {
		this.#defs.set(def.name, { def, source });
		for (const example of def.examples ?? []) {
			try {
				this.validate(def.name, example.input);
			} catch (error) {
				console.warn(
					`[assistant] ${source}: example "${example.label}" does not match the input schema: ${messageOf(error)}`,
				);
			}
		}
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
				...(def.examples?.length ? { examples: JSON.parse(JSON.stringify(def.examples)) } : {}),
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

/** Thrown by `ask()` to park the run until the question is answered. */
class AskPark extends Error {
	constructor(
		readonly ask: { key: string; question: string; choices?: string[]; placeholder?: string; deadline: number | null },
		readonly questionTaskId: number | undefined,
	) {
		super(`waiting for an answer to "${ask.question}"`);
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
	hooks: QuestionHooks,
): WorkflowContext<unknown> {
	const runId = Number(task.id);
	const used = new Set<string>();
	const counters = { agent: 0, exec: 0, ask: 0 };
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
		async ask(question: string, options?: AskOptions): Promise<string> {
			const key = options?.key ?? `ask-${++counters.ask}`;
			if (used.has(`ask:${key}`))
				throw new Error(`Workflow question "${key}" asked twice in one run; keys must be unique`);
			used.add(`ask:${key}`);
			if (mode.replay && stopped) throw new ReplayStop();
			const memoKey = `answer:${key}`;
			const stored = await runtime.memo<{ value: string }>(memoKey, context);
			if (stored !== undefined) return stored.value;
			if (mode.replay) {
				stopped = true;
				throw new ReplayStop();
			}
			const answers = await runtime.snapshot(AnswersDoc, runtime.conversationId, context);
			const answer = answers?.answers[`${runId}:${key}`];
			if (answer !== undefined) {
				const kept = await runtime.memo<{ value: string }>(memoKey, { value: answer }, context);
				await stepEntry(
					runtime,
					{ runId, step: key, title: question, status: "done", summary: `→ ${kept.value}` },
					context,
				);
				hooks.waiting(Number(runtime.conversationId), runId, key, false);
				return kept.value;
			}
			const questions = await runtime.snapshot(QuestionsDoc, task.id, context);
			const questionTaskId = questions?.questions[key];
			if (questionTaskId !== undefined) {
				const record = await runtime.getTask(questionTaskId as never, context);
				if (record?.state.status === "terminal") {
					// The question ended without an answer: its deadline passed.
					hooks.waiting(Number(runtime.conversationId), runId, key, false);
					await stepEntry(
						runtime,
						{ runId, step: key, title: question, status: "failed", summary: "no answer in time" },
						context,
					);
					throw new Error(`No answer to "${question}" in time`);
				}
			}
			const deadline =
				options?.timeoutMs === undefined
					? null
					: await runtime.memo<number>(`deadline:${key}`, runtime.now() + options.timeoutMs, context);
			throw new AskPark(
				{ key, question, choices: options?.choices, placeholder: options?.placeholder, deadline },
				questionTaskId,
			);
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
	hooks: QuestionHooks,
): Promise<{ undone: string[]; failures: string[] }> {
	if (!def) return { undone: [], failures: ["the workflow is no longer installed, so its steps cannot be undone"] };
	const finished: Finished[] = [];
	try {
		await def.run(createContext(task, runtime, context, cwd, { replay: true, finished }, hooks));
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

const NO_HOOKS: QuestionHooks = { waiting: () => {} };

export function createWorkflowTask(
	catalog: WorkflowCatalog,
	cwdOf: (sessionId: number) => string | undefined,
	hooks: QuestionHooks = NO_HOOKS,
) {
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

	/** Wait for an answer: create the question task (once per key) and wait on it, holding no process. */
	const park = async (task: Task, runtime: Runtime, context: Context, parked: AskPark) => {
		const runId = Number(task.id);
		await runtime.commit(async (tx) => {
			let questionTaskId = parked.questionTaskId;
			if (questionTaskId === undefined) {
				const { key, question, choices, placeholder, deadline } = parked.ask;
				questionTaskId = Number(
					await tx.createTask(QuestionTask, { runId, key, deadline }, { ownership: { kind: "task", taskId: task.id } }),
				);
				(await tx.doc(QuestionsDoc, task.id)).questions[key] = questionTaskId;
				const ask: WorkflowAskData = {
					runId,
					key,
					question,
					...(choices?.length ? { choices } : {}),
					...(placeholder ? { placeholder } : {}),
					...(deadline !== null ? { deadline } : {}),
				};
				await tx.appendEntry(runtime.conversationId, { kind: WorkflowAsk.kind, data: ask as unknown as JsonValue });
				await tx.appendEntry(runtime.conversationId, {
					kind: WorkflowStep.kind,
					data: {
						runId,
						step: key,
						title: question,
						status: "waiting",
					} satisfies WorkflowStepData as unknown as JsonValue,
				});
			}
			// One task to wait on, so "allSettled" wakes the run as soon as the question ends.
			return { status: "waiting", on: [questionTaskId as never], policy: "allSettled", checkpoint: { phase: "run" } };
		}, context);
		hooks.waiting(Number(runtime.conversationId), runId, parked.ask.key, true);
	};

	const revert = async (task: Task, runtime: Runtime, context: Context, reason: string) => {
		const def = catalog.get(task.input.name);
		await appendEntry(
			runtime,
			{ kind: WorkflowRollback.kind, data: { runId: Number(task.id), reason } satisfies WorkflowRollbackData },
			context,
		);
		return rollback(def, task, runtime, context, cwdOf(Number(runtime.conversationId)), hooks);
	};

	const workflowTask = defineTask<RunInput, RunState, JsonValue>({
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
				const ctx = createContext(
					task,
					runtime,
					context,
					cwdOf(Number(runtime.conversationId)),
					{ replay: false },
					hooks,
				);
				let result: JsonValue;
				try {
					const value = await def.run(ctx);
					result = value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
				} catch (error) {
					if (runtime.signal.aborted) throw error; // the abort handler rolls back and records the outcome
					if (error instanceof AskPark) {
						await park(task, runtime, context, error);
						return;
					}
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
	return workflowTask;
}

export type WorkflowTaskDef = ReturnType<typeof createWorkflowTask>;

export function createWorkflowExtension(task: WorkflowTaskDef): Extension {
	return defineExtension({ name: "tiny-workflows", tasks: [task, QuestionTask] });
}
