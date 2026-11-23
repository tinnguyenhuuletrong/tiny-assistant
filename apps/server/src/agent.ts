/**
 * Engine turns as pi-durable tasks. A session run by an engine other than `pi` (Claude Code, ...) has no pi-durable
 * generation: each message the user sends becomes one `tiny.agent.turn` task owned by the session's conversation.
 *
 * - `wait`: a message sent while a turn runs queues behind it (the task waits on the previous turn's task).
 * - `start`: one commit places the user message in the transcript and marks the turn running.
 * - `run`: runs the engine and records what it reports as it comes: finished assistant messages and tool results as
 *   entries (in pi-ai's message shapes, so display, search, and metrics need nothing new), the message being written
 *   as live state in the `tiny.agent` document (deferred commits, at most every 100 ms), spend in the same document.
 *
 * What survives a crash: every finished message and tool result (each one is committed before the next is read), and
 * the engine's own session handle, so the next turn resumes the engine's context. A turn the daemon died during is
 * not run again, because its tools may already have changed files: it ends `interrupted`, and the next message
 * continues the engine session where it stopped. Stop aborts the task, which kills the engine's process and keeps what
 * was being written, marked aborted.
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
import {
	AGENT_DOC,
	AGENT_ENTRY_KINDS,
	type AgentLiveData,
	type AgentNoticeData,
	type ThinkingLevel,
} from "@tiny/core/protocol";
import { type Attachment, attachmentInfo, type PreparedAttachment, userContent } from "./attachments.ts";
import type { EngineRegistry } from "./engines/index.ts";
import { type AssistantMessageData, emptyUsage, type ToolResultMessageData, type UsageData } from "./engines/types.ts";

export const AgentDoc = defineDoc<AgentLiveData>({
	kind: AGENT_DOC,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => newAgentData(""),
	checkpointWhen: () => false,
});

export function newAgentData(engine: string): AgentLiveData {
	return {
		engine,
		resume: null,
		run: null,
		queue: [],
		message: null,
		retry: null,
		failure: null,
		usage: { models: {} },
		costSeen: 0,
		requests: [],
	};
}

export const AgentUser = defineEntry(AGENT_ENTRY_KINDS.user);
export const AgentAssistant = defineEntry(AGENT_ENTRY_KINDS.assistant);
export const AgentToolResult = defineEntry(AGENT_ENTRY_KINDS.toolResult);
export const AgentNotice = defineEntry<AgentNoticeData>(AGENT_ENTRY_KINDS.notice);

/** What a turn needs to know about its session, read when the turn starts (so model changes apply to the next turn). */
export type AgentSession = { engine: string; model: string | null; thinking: ThinkingLevel | null; cwd: string | null };

type TurnInput = { prompt: string; after: number | null; attachments?: Attachment[] };

/** Prepare a turn's attachments for its session's engine (what it takes natively, images resized). */
export type PrepareAttachments = (
	sessionId: number,
	attachments: readonly Attachment[],
) => Promise<PreparedAttachment[]>;
type TurnState = { phase: "wait" } | { phase: "start" } | { phase: "run" };
type Runtime = TaskRuntime<TurnInput, TurnState, JsonValue, object>;
type Task = RunningTask<TurnInput, TurnState, JsonValue>;

/** How often the message being written is committed while it streams. */
const PARTIAL_INTERVAL_MS = 100;

type Outcome = { status: "completed" } | { status: "failed"; reason: string; detail?: string } | { status: "aborted" };

function asModel(message: AssistantMessageData | ToolResultMessageData | Record<string, unknown>): never {
	return [message] as never;
}

function addUsage(doc: AgentLiveData, key: string, usage: UsageData): void {
	const current = (doc.usage.models[key] ?? emptyUsage()) as unknown as UsageData;
	doc.usage.models[key] = {
		input: current.input + usage.input,
		output: current.output + usage.output,
		cacheRead: current.cacheRead + usage.cacheRead,
		cacheWrite: current.cacheWrite + usage.cacheWrite,
		totalTokens: current.totalTokens + usage.totalTokens,
		cost: {
			input: current.cost.input + usage.cost.input,
			output: current.cost.output + usage.cost.output,
			cacheRead: current.cost.cacheRead + usage.cost.cacheRead,
			cacheWrite: current.cost.cacheWrite + usage.cost.cacheWrite,
			total: current.cost.total + usage.cost.total,
		},
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createAgentTask(
	engines: EngineRegistry,
	sessionOf: (sessionId: number) => AgentSession | undefined,
	prepare: PrepareAttachments,
) {
	/** End the turn. A failed or stopped turn keeps the message it was writing, marked as such. */
	const finish = async (task: Task, runtime: Runtime, context: Context, outcome: Outcome) => {
		const taskId = Number(task.id);
		await runtime.commit(async (tx) => {
			const doc = await tx.doc(AgentDoc, runtime.conversationId);
			doc.queue = doc.queue.filter((id) => id !== taskId);
			if (doc.run?.taskId === taskId) {
				const partial = doc.message as unknown as AssistantMessageData | null;
				if (partial && partial.content.length > 0 && outcome.status !== "completed") {
					await tx.appendEntry(runtime.conversationId, {
						kind: AgentAssistant.kind,
						model: asModel({
							...partial,
							stopReason: outcome.status === "aborted" ? "aborted" : "error",
							...(outcome.status === "failed" && outcome.detail ? { errorMessage: outcome.detail } : {}),
						}),
					});
				}
				doc.run = null;
				doc.message = null;
				doc.retry = null;
				doc.failure =
					outcome.status === "completed"
						? null
						: outcome.status === "aborted"
							? { reason: "aborted" }
							: { reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) };
			}
			if (outcome.status === "completed") return { status: "terminal", outcome: { status: "completed", result: null } };
			if (outcome.status === "aborted") return { status: "terminal", outcome: { status: "aborted" } };
			return {
				status: "terminal",
				outcome: { status: "failed", error: { message: outcome.detail ?? outcome.reason } },
			};
		}, context);
	};

	const run = async (task: Task, runtime: Runtime, context: Context) => {
		const conversationId = runtime.conversationId;
		const sessionId = Number(conversationId);
		if ((await runtime.memo<boolean>("launched", context)) !== undefined) {
			// The daemon stopped mid-turn. The engine may already have changed files, so don't run the prompt again.
			await finish(task, runtime, context, {
				status: "failed",
				reason: "interrupted",
				detail: "tiny stopped during this turn. Send a message to continue where the engine left off.",
			});
			return;
		}
		await runtime.memo("launched", true, context);

		const session = sessionOf(sessionId);
		const engine = session ? engines.get(session.engine) : undefined;
		if (!session || !engine) {
			await finish(task, runtime, context, {
				status: "failed",
				reason: "no_model",
				detail: `The ${session?.engine ?? "session's"} engine is not available on this daemon`,
			});
			return;
		}
		const state = await runtime.snapshot(AgentDoc, conversationId, context);
		let resume = state?.resume ?? null;
		const slash = session.model?.indexOf("/") ?? -1;
		const model = session.model && slash > 0 ? session.model.slice(slash + 1) : session.model;

		// The finished assistant message not committed yet: held until the next event, so the turn's usage can go on the
		// last one. While held it is shown as the live message.
		let held: AssistantMessageData | null = null;
		let partial: AssistantMessageData | null = null;
		let disarm: (() => void) | undefined;
		let flushing: Promise<void> = Promise.resolve();

		const commitPartial = () => {
			disarm = undefined;
			const message = partial ?? held;
			flushing = flushing
				.then(() =>
					runtime.commit(
						async (tx) => {
							const doc = await tx.doc(AgentDoc, conversationId);
							doc.message = message as unknown as AgentLiveData["message"];
							if (doc.retry) doc.retry = null;
							return undefined;
						},
						context,
						{ persistence: { kind: "deferred" } },
					),
				)
				.catch(() => {
					// Refused after Stop; the abort handler records the turn.
				});
		};
		const schedule = () => {
			disarm ??= runtime.setTimer(commitPartial, PARTIAL_INTERVAL_MS);
		};
		const settlePartials = async () => {
			disarm?.();
			disarm = undefined;
			await flushing;
		};

		/** Commit the held message (and more in the same commit). */
		const commitHeld = async (more?: (tx: Parameters<Parameters<Runtime["commit"]>[0]>[0]) => Promise<void>) => {
			await settlePartials();
			const message = held;
			held = null;
			partial = null;
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(AgentDoc, conversationId);
				if (message) {
					await tx.appendEntry(conversationId, { kind: AgentAssistant.kind, model: asModel(message) });
					if (doc.run) doc.run.turns++;
				}
				doc.message = null;
				await more?.(tx);
				return undefined;
			}, context);
		};

		try {
			const attachments = await prepare(sessionId, task.input.attachments ?? []);
			for await (const event of engine.run({
				prompt: task.input.prompt,
				attachments,
				sessionId,
				cwd: session.cwd ?? undefined,
				model,
				thinking: session.thinking,
				resume,
				signal: runtime.signal,
			})) {
				switch (event.type) {
					case "session": {
						if (event.id === resume) break;
						const fresh = resume === null;
						resume = event.id;
						await runtime.commit(async (tx) => {
							const doc = await tx.doc(AgentDoc, conversationId);
							doc.resume = event.id;
							// A new engine session counts its cost from zero.
							if (!fresh) doc.costSeen = 0;
							return undefined;
						}, context);
						break;
					}
					case "partial":
						// A partial after a finished message belongs to the next one (the engine reports a message finished only
						// when it moves on): commit the held one, so it stays on screen.
						if (held) await commitHeld();
						partial = event.message;
						schedule();
						break;
					case "assistant":
						if (held) await commitHeld();
						held = event.message;
						partial = null;
						schedule();
						break;
					case "toolResult":
						await commitHeld(async (tx) => {
							await tx.appendEntry(conversationId, { kind: AgentToolResult.kind, model: asModel(event.message) });
						});
						break;
					case "retry":
						await runtime.commit(
							async (tx) => {
								(await tx.doc(AgentDoc, conversationId)).retry = { at: event.at, error: event.error };
								return undefined;
							},
							context,
							{ persistence: { kind: "deferred" } },
						);
						break;
					case "notice":
						await runtime.commit(async (tx) => {
							await tx.appendEntry(conversationId, {
								kind: AgentNotice.kind,
								data: { level: event.level, text: event.text },
							});
							return undefined;
						}, context);
						break;
					case "done": {
						await settlePartials();
						const usage = event.usage ?? emptyUsage();
						const last = held;
						await runtime.commit(async (tx) => {
							const doc = await tx.doc(AgentDoc, conversationId);
							let cost = 0;
							const total = event.cumulativeCost;
							// A zeroed total (a crash or startup-error result) says nothing: keep the running total, or the next
							// turn would count the whole session again. A lower nonzero total is a new baseline (`/clear`).
							if (total !== undefined && total > 0) {
								cost = total >= doc.costSeen ? total - doc.costSeen : total;
								doc.costSeen = total;
							}
							const turnUsage: UsageData = { ...usage, cost: { ...usage.cost, total: cost } };
							if (last) {
								last.usage = turnUsage;
								await tx.appendEntry(conversationId, { kind: AgentAssistant.kind, model: asModel(last) });
								if (doc.run) doc.run.turns++;
								doc.message = null;
							}
							addUsage(
								doc,
								last ? `${last.provider}/${last.model}` : `${session.engine}/${model ?? "default"}`,
								turnUsage,
							);
							return undefined;
						}, context);
						held = null;
						await finish(
							task,
							runtime,
							context,
							event.error ? { status: "failed", reason: "model_error", detail: event.error } : { status: "completed" },
						);
						return;
					}
				}
			}
			// The engine ended without saying so: keep what it wrote.
			if (held) await commitHeld();
			await finish(task, runtime, context, { status: "completed" });
		} catch (error) {
			if (runtime.signal.aborted) throw error; // the abort handler records the turn
			await settlePartials().catch(() => undefined);
			if (held) await commitHeld().catch(() => undefined);
			await finish(task, runtime, context, { status: "failed", reason: "model_error", detail: messageOf(error) });
		}
	};

	return defineTask<TurnInput, TurnState, JsonValue>({
		name: "tiny.agent.turn",
		version: 1,
		initial: (input) => (input.after === null ? { phase: "start" } : { phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				await runtime.commit(async (tx) => {
					const previous = task.input.after === null ? undefined : await tx.task(task.input.after as never);
					if (previous && previous.state.status !== "terminal") {
						return {
							status: "waiting",
							on: [previous.id],
							policy: "allSettled",
							checkpoint: { phase: "start" },
						};
					}
					return { status: "running", checkpoint: { phase: "start" } };
				}, context);
			},
			start: async (task, runtime, context) => {
				const taskId = Number(task.id);
				const attachments = task.input.attachments ?? [];
				const prepared = await prepare(Number(runtime.conversationId), attachments);
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(AgentDoc, runtime.conversationId);
					doc.queue = doc.queue.filter((id) => id !== taskId);
					doc.run = { taskId, startedAt: runtime.now(), turns: 0 };
					doc.message = null;
					doc.retry = null;
					doc.failure = null;
					await tx.appendEntry(runtime.conversationId, {
						kind: AgentUser.kind,
						model: asModel({
							role: "user",
							content: userContent(task.input.prompt, prepared) as never,
							timestamp: runtime.now(),
						}),
						...(attachments.length > 0
							? { data: { text: task.input.prompt, attachments: attachments.map(attachmentInfo) } }
							: {}),
					});
					return { status: "running", checkpoint: { phase: "run" } };
				}, context);
			},
			run,
		},
		abort: (task, runtime, context) => finish(task, runtime, context, { status: "aborted" }),
	});
}

export type AgentTaskDef = ReturnType<typeof createAgentTask>;

export function createAgentExtension(task: AgentTaskDef): Extension {
	return defineExtension({ name: "tiny-agents", tasks: [task] });
}

/** Re-root a document watch's Chord ops under `docs[AGENT_DOC]` of a conversation view. */
export function agentDocOps(ops: readonly (readonly unknown[])[]): unknown[][] {
	const root = ["docs", AGENT_DOC];
	return ops.map((op) => {
		const [kind, ...rest] = op as [string, ...unknown[]];
		if (kind === "r") return ["s", root, rest[0]];
		const [path, ...args] = rest as [readonly (string | number)[], ...unknown[]];
		return [kind, [...root, ...path], ...args];
	});
}
