/**
 * Engines: what runs a session's turns.
 *
 * `pi` is tiny's own loop (pi-durable runs the model and every tool call). Every other engine wraps an external coding
 * agent (Claude Code now; Codex, Antigravity, ... later) that runs a whole turn itself, in the project folder, with its
 * own tools, skills, MCP servers, and settings. The engine turns that agent's output into the events below; the
 * durable turn task (`../agent.ts`) writes them into the session as entries and live state, so the web app, the TUI,
 * search, and metrics see an engine session exactly like a pi session.
 *
 * To add an engine: implement `Engine` in a file next to this one and list it in `./index.ts`.
 */
import type { ThinkingLevel } from "@tiny/core/protocol";

/** pi-ai's message shapes, as JSON: what the entries' `model` field holds. */
export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean };
export type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type UsageData = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export type AssistantMessageData = {
	role: "assistant";
	content: (TextBlock | ThinkingBlock | ToolCallBlock)[];
	api: string;
	provider: string;
	model: string;
	usage: UsageData;
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	errorMessage?: string;
	timestamp: number;
};

export type ToolResultMessageData = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextBlock | { type: "image"; data: string; mimeType: string })[];
	isError: boolean;
	details?: unknown;
	timestamp: number;
};

export type TurnInput = {
	prompt: string;
	/** The session's project folder; absent for a plain chat. */
	cwd: string | undefined;
	/** The model id without its provider (`claude-opus-5-5`), or null for the engine's own default. */
	model: string | null;
	thinking: ThinkingLevel | null;
	/** The engine session to continue, as reported by an earlier `session` event; null starts a new one. */
	resume: string | null;
	/** Aborted when the user stops the turn or the daemon shuts down. The engine must stop its process. */
	signal: AbortSignal;
};

export type TurnEvent =
	/** The engine's session handle, for `resume` on the next turn. Report it as early as possible. */
	| { type: "session"; id: string }
	/**
	 * The assistant message as it is being written: every block so far, the last one possibly incomplete. Sent often;
	 * the task throttles what it stores.
	 */
	| { type: "partial"; message: AssistantMessageData }
	/** A finished assistant message. Its tool calls are followed by their `toolResult`s. */
	| { type: "assistant"; message: AssistantMessageData }
	| { type: "toolResult"; message: ToolResultMessage }
	/** The engine is retrying a failed model request at `at`. */
	| { type: "retry"; at: number; error: string }
	/** Worth showing, but not a message: loaded MCP servers, a compaction, a warning. */
	| { type: "notice"; level: "info" | "warn" | "error"; text: string }
	/**
	 * The turn ended. `usage` is the turn's total, added to its last assistant message. `error` means it ended without
	 * an answer. An engine that reports cost as a running total for its session (Claude Code does) sets
	 * `cumulativeCost`; the turn's cost is then its increase since the previous turn.
	 */
	| { type: "done"; usage?: UsageData; cumulativeCost?: number; error?: string };

export type ToolResultMessage = ToolResultMessageData;

export interface Engine {
	readonly id: string;
	readonly name: string;
	/** Shown under the engine in the pickers. */
	readonly note: string;
	/** Model providers whose models this engine can run; absent: all. */
	readonly modelProviders?: string[];
	/** Whether the engine can run here, and why not. Cheap: called whenever clients load state. */
	availability(): { available: boolean; reason?: string };
	/** Run one turn. Events end with `done`; throwing ends the turn as failed with the error's message. */
	run(input: TurnInput): AsyncIterable<TurnEvent>;
}

export function emptyUsage(): UsageData {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
