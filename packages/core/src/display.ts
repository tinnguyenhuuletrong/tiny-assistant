/**
 * Turns a pi-durable conversation view into a flat list of display items, shared by the web UI and the TUI so both
 * show exactly the same thing. Pure functions over JSON: safe in browsers.
 */
import {
	type ConversationViewValue,
	ENTRY_KINDS,
	type ViewEntry,
	type WorkflowAskData,
	type WorkflowFinishedData,
	type WorkflowLogData,
	type WorkflowRollbackData,
	type WorkflowStartedData,
	type WorkflowStepData,
} from "./protocol.ts";

export type ToolState = {
	callId: string;
	name: string;
	args: Record<string, unknown>;
	status: "pending" | "running" | "parked" | "done" | "error";
	/** Result text (done) or live output (running). */
	output: string;
	details?: unknown;
};

export type AssistantPart =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string; redacted?: boolean }
	| { type: "tool"; tool: ToolState };

export type UsageInfo = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

export type WorkflowStepStatus = WorkflowStepData["status"];

/** One workflow run, folded from its entries: what a diagram of the run needs. */
export type WorkflowRun = {
	runId: number;
	name: string;
	input: unknown;
	/** `waiting` while a question is open; `rolling_back` from the rollback entry until the run finishes. */
	phase: "running" | "waiting" | "rolling_back" | "completed" | "failed" | "aborted";
	/** Steps in the order they started, each with its latest status. `name` is what to show; `key` identifies it. */
	steps: { key: string; name: string; status: WorkflowStepStatus; summary?: string }[];
	/** The question the run is waiting on, if any. */
	question: WorkflowAskData | null;
	logs: { text: string; level: "info" | "warn" | "error" }[];
	rollbackReason: string | null;
	result?: unknown;
	error?: string;
	/** Steps undone by the rollback, newest first. */
	rolledBack: string[];
};

export type DisplayItem =
	| { type: "user"; key: string; entryId: number; text: string; images: { mimeType: string; data: string }[] }
	| {
			type: "assistant";
			key: string;
			entryId: number | null;
			parts: AssistantPart[];
			model: string | null;
			streaming: boolean;
			error: string | null;
			stopReason: string | null;
			usage: UsageInfo | null;
	  }
	| { type: "compaction"; key: string; entryId: number; summary: string }
	| { type: "reset"; key: string; entryId: number; handoff: string | null }
	| { type: "workflow"; key: string; entryId: number; event: WorkflowEvent }
	/** A whole run, shown where it started and updated as its entries arrive. */
	| { type: "workflow-run"; key: string; entryId: number; run: WorkflowRun }
	| { type: "notice"; key: string; level: "info" | "warn" | "error"; text: string };

export type WorkflowEvent =
	| ({ kind: "started" } & WorkflowStartedData)
	| ({ kind: "step" } & WorkflowStepData)
	| ({ kind: "log" } & WorkflowLogData)
	| ({ kind: "finished" } & WorkflowFinishedData);

export type LiveSummary = {
	busy: boolean;
	/** The model is generating (as opposed to running tools). */
	generating: boolean;
	retry: { at: number; error: string } | null;
	compacting: boolean;
	queued: number;
	failure: { reason: string; detail: string | null } | null;
	turns: number;
};

type Msg = { role?: string; content?: unknown; [key: string]: unknown };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && (part as Msg).type === "text" ? String((part as Msg).text) : "",
		)
		.join("");
}

function imagesOf(content: unknown): { mimeType: string; data: string }[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((part) => part && typeof part === "object" && (part as Msg).type === "image")
		.map((part) => ({ mimeType: String((part as Msg).mimeType), data: String((part as Msg).data) }));
}

function usageOf(message: Msg): UsageInfo | null {
	const usage = message.usage as Record<string, unknown> | undefined;
	if (!usage) return null;
	const cost = usage.cost as Record<string, number> | undefined;
	return {
		input: Number(usage.input ?? 0),
		output: Number(usage.output ?? 0),
		cacheRead: Number(usage.cacheRead ?? 0),
		cacheWrite: Number(usage.cacheWrite ?? 0),
		cost: Number(cost?.total ?? 0),
	};
}

function assistantParts(message: Msg, results: Map<string, ToolState>): AssistantPart[] {
	const parts: AssistantPart[] = [];
	const content = Array.isArray(message.content) ? (message.content as Msg[]) : [];
	for (const block of content) {
		if (block.type === "text") {
			const text = String(block.text ?? "");
			if (text.length > 0) parts.push({ type: "text", text });
		} else if (block.type === "thinking") {
			const text = String(block.thinking ?? "");
			if (text.length > 0 || block.redacted) parts.push({ type: "thinking", text, redacted: Boolean(block.redacted) });
		} else if (block.type === "toolCall") {
			const callId = String(block.id);
			const tool = results.get(callId) ?? {
				callId,
				name: String(block.name),
				args: (block.arguments as Record<string, unknown>) ?? {},
				status: "pending" as const,
				output: "",
			};
			tool.args = (block.arguments as Record<string, unknown>) ?? tool.args;
			results.set(callId, tool);
			parts.push({ type: "tool", tool });
		}
	}
	return parts;
}

/** Entry kinds that are bookkeeping only. */
const HIDDEN = new Set(["pi.system"]);

/**
 * Build display items from the entries a client holds (the view's window plus any earlier pages it loaded) and the
 * view's live documents.
 */
export function buildDisplay(entries: readonly ViewEntry[], docs: ConversationViewValue["docs"]): DisplayItem[] {
	const items: DisplayItem[] = [];
	const tools = new Map<string, ToolState>();
	const runs = new Map<number, WorkflowRun>();
	/**
	 * The run an entry belongs to. When its `started` entry is outside the loaded window (a long run), the card starts
	 * here instead, so steps, logs, and an open question still show.
	 */
	const runFor = (runId: number, entryId: number, name?: string): WorkflowRun => {
		let run = runs.get(runId);
		if (!run) {
			run = {
				runId,
				name: name ?? "workflow",
				input: undefined,
				phase: "running",
				steps: [],
				question: null,
				logs: [],
				rollbackReason: null,
				rolledBack: [],
			};
			runs.set(runId, run);
			items.push({ type: "workflow-run", key: `run${runId}`, entryId, run });
		}
		return run;
	};

	// Tool results first, so calls render with their results attached wherever they are.
	for (const entry of entries) {
		if (entry.kind !== "pi.tool-result") continue;
		const message = entry.model?.[0] as Msg | undefined;
		if (!message) continue;
		const callId = String(message.toolCallId);
		tools.set(callId, {
			callId,
			name: String(message.toolName),
			args: {},
			status: message.isError ? "error" : "done",
			output: textOf(message.content),
			details: (entry.data as Record<string, unknown> | undefined)?.details ?? message.details,
		});
	}

	for (const entry of entries) {
		if (HIDDEN.has(entry.kind) || entry.kind === "pi.tool-result") continue;
		const key = `e${entry.id}`;
		const message = entry.model?.[0] as Msg | undefined;
		switch (entry.kind) {
			case "pi.assistant": {
				if (!message) break;
				items.push({
					type: "assistant",
					key,
					entryId: entry.id,
					parts: assistantParts(message, tools),
					model: message.model ? String(message.model) : null,
					streaming: false,
					error: message.errorMessage ? String(message.errorMessage) : null,
					stopReason: message.stopReason ? String(message.stopReason) : null,
					usage: usageOf(message),
				});
				break;
			}
			case "pi.compaction": {
				const data = entry.data as { summary?: string } | undefined;
				items.push({ type: "compaction", key, entryId: entry.id, summary: data?.summary ?? textOf(message?.content) });
				break;
			}
			case "pi.reset": {
				items.push({ type: "reset", key, entryId: entry.id, handoff: message ? textOf(message.content) : null });
				break;
			}
			case ENTRY_KINDS.workflowStarted: {
				const data = entry.data as WorkflowStartedData;
				const run: WorkflowRun = {
					runId: data.runId,
					name: data.name,
					input: data.input,
					phase: "running",
					steps: [],
					question: null,
					logs: [],
					rollbackReason: null,
					rolledBack: [],
				};
				runs.set(data.runId, run);
				items.push({ type: "workflow-run", key, entryId: entry.id, run });
				break;
			}
			case ENTRY_KINDS.workflowStep: {
				const data = entry.data as WorkflowStepData;
				const run = runFor(data.runId, entry.id);
				const step = run.steps.find((candidate) => candidate.key === data.step);
				if (step) {
					step.status = data.status;
					step.summary = data.summary;
				} else {
					run.steps.push({ key: data.step, name: data.title ?? data.step, status: data.status, summary: data.summary });
				}
				// An answered (or expired) question closes.
				if (run.question?.key === data.step && data.status !== "waiting") {
					run.question = null;
					if (run.phase === "waiting") run.phase = "running";
				}
				break;
			}
			case ENTRY_KINDS.workflowAsk: {
				const data = entry.data as WorkflowAskData;
				const run = runFor(data.runId, entry.id);
				if (run.phase === "running" || run.phase === "waiting") {
					run.question = data;
					run.phase = "waiting";
				}
				break;
			}
			case ENTRY_KINDS.workflowLog: {
				const data = entry.data as WorkflowLogData;
				runFor(data.runId, entry.id).logs.push({ text: data.text, level: data.level });
				break;
			}
			case ENTRY_KINDS.workflowRollback: {
				const data = entry.data as WorkflowRollbackData;
				const run = runFor(data.runId, entry.id);
				run.question = null;
				run.phase = "rolling_back";
				run.rollbackReason = data.reason;
				break;
			}
			case ENTRY_KINDS.workflowFinished: {
				const data = entry.data as WorkflowFinishedData;
				const run = runs.get(data.runId);
				if (run) {
					run.question = null;
					run.phase = data.status;
					run.result = data.result;
					run.error = data.error;
					run.rolledBack = data.rolledBack ?? [];
					// Nothing is still running once the run ended: close steps that were cut off.
					for (const step of run.steps) {
						if (step.status === "running" || step.status === "undoing") {
							step.status = "failed";
							step.summary ??= data.status === "aborted" ? "stopped" : "did not finish";
						} else if (step.status === "waiting") {
							step.status = "failed";
							step.summary = "not answered";
						}
					}
				}
				// Repeat the outcome at the end only when other messages (agent turns) came in between.
				const previous = items[items.length - 1];
				if (!(previous?.type === "workflow-run" && previous.run.runId === data.runId)) {
					items.push({ type: "workflow", key, entryId: entry.id, event: { kind: "finished", ...data } });
				}
				break;
			}
			default: {
				// pi.user, and inputs submitted with a custom entry kind: anything carrying a user message.
				if (message?.role === "user") {
					items.push({
						type: "user",
						key,
						entryId: entry.id,
						text: textOf(message.content),
						images: imagesOf(message.content),
					});
				}
			}
		}
	}

	// Live state: running tool output and the streamed partial answer.
	const live = (docs["pi.live"] ?? {}) as Record<string, unknown>;
	const slots = (live.tools as Record<string, unknown>[] | undefined) ?? [];
	for (const slot of slots) {
		const callId = String(slot.callId);
		const tool = tools.get(callId);
		if (!tool || tool.status === "done" || tool.status === "error") continue;
		const status = String(slot.status);
		tool.status = status === "sleeping" || status === "waiting" ? "parked" : status === "done" ? "done" : "running";
		tool.output = String(slot.output ?? "");
		if (slot.details !== undefined) tool.details = slot.details;
	}
	const generation = live.generation as { message?: Msg; retry?: { at: number; error: string } } | undefined;
	if (generation?.message) {
		items.push({
			type: "assistant",
			key: "live",
			entryId: null,
			parts: assistantParts(generation.message, tools),
			model: generation.message.model ? String(generation.message.model) : null,
			streaming: true,
			error: null,
			stopReason: null,
			usage: null,
		});
	}
	const failure = live.runFailure as { reason: string; detail?: string } | undefined;
	if (failure && !live.run) {
		items.push({
			type: "notice",
			key: "failure",
			level: failure.reason === "aborted" ? "warn" : "error",
			text: failureText(failure.reason, failure.detail),
		});
	}
	return items;
}

export function failureText(reason: string, detail?: string | null): string {
	const labels: Record<string, string> = {
		aborted: "Stopped",
		model_error: "Model error",
		no_model: "No model available",
		interrupted: "Interrupted",
		restart_limit: "Gave up after repeated crashes",
		turn_limit: "Reached the turn limit",
		nothing_to_answer: "Nothing to answer",
		faulted: "Run faulted",
		orphaned: "Run orphaned",
		reset: "Context reset",
	};
	const label = labels[reason] ?? reason;
	return detail ? `${label}: ${detail}` : label;
}

export function summarizeLive(docs: ConversationViewValue["docs"]): LiveSummary {
	const live = (docs["pi.live"] ?? {}) as Record<string, unknown>;
	const run = live.run as { turns?: number } | undefined;
	const generation = live.generation as { retry?: { at: number; error: string } } | undefined;
	const inbox = (docs["pi.inbox"] ?? {}) as { items?: unknown[] };
	const failure = live.runFailure as { reason: string; detail?: string } | undefined;
	return {
		busy: run !== undefined,
		generating: generation !== undefined,
		retry: generation?.retry ?? null,
		compacting: Array.isArray(live.compactions) && live.compactions.length > 0,
		queued: Array.isArray(inbox.items) ? inbox.items.length : 0,
		failure: failure && !run ? { reason: failure.reason, detail: failure.detail ?? null } : null,
		turns: run?.turns ?? 0,
	};
}

/** Total spend of a session, from its `pi.usage` document. */
export function sessionUsage(docs: ConversationViewValue["docs"]): UsageInfo {
	const usage = (docs["pi.usage"] ?? {}) as { models?: Record<string, Record<string, unknown>> };
	const total: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const value of Object.values(usage.models ?? {})) {
		const u = usageOf({ usage: value });
		if (!u) continue;
		total.input += u.input;
		total.output += u.output;
		total.cacheRead += u.cacheRead;
		total.cacheWrite += u.cacheWrite;
		total.cost += u.cost;
	}
	return total;
}

/** A one-line summary of a tool call's arguments for headers. */
export function toolSummary(tool: ToolState): string {
	const args = tool.args;
	const pick = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
	const value = pick("command") ?? pick("path") ?? pick("file_path") ?? pick("pattern") ?? pick("query") ?? pick("url");
	if (value !== undefined) return value.split("\n")[0]!.slice(0, 160);
	const json = JSON.stringify(args);
	return json === "{}" ? "" : json.slice(0, 160);
}
