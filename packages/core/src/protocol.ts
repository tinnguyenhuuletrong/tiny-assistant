/**
 * Wire protocol shared by the server, the web app, and the TUI.
 *
 * REST (`/api/*`) carries mutations and listings. One WebSocket (`/ws`) carries live state: the session list, and for
 * each subscribed session the pi-durable conversation view, sent once whole and then as Chord delta ops that clients
 * apply with `applyImmutable` from `@earendil-works/chord/delta`. Every client sees the same committed state, which is
 * what keeps the web UI and the TUI in sync.
 */

/** pi-durable's `ConversationView`, kept structural here so browser bundles need no server types. */
export type ViewEntry = {
	readonly id: number;
	readonly conversationId: number;
	readonly kind: string;
	readonly model?: readonly unknown[];
	readonly data?: unknown;
	readonly head?: number;
	readonly byTaskId?: number;
};

export type ConversationViewValue = {
	readonly conversation: { readonly id: number };
	readonly entries: readonly ViewEntry[];
	readonly before?: number;
	readonly docs: Readonly<Record<string, Record<string, unknown>>>;
};

/** Any JSON value. */
export type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

/** Chord delta op, as the watch sends it. Clients pass these straight to `applyImmutable`. */
export type DeltaOp = readonly unknown[];

export type ProjectInfo = {
	id: string;
	name: string;
	path: string;
	createdAt: number;
};

export type SessionInfo = {
	/** The pi-durable conversation id. */
	id: number;
	projectId: string | null;
	title: string;
	createdAt: number;
	updatedAt: number;
	archived: boolean;
	pinned: boolean;
	/** A run or a workflow is in progress. */
	busy: boolean;
	/** A workflow run is in progress in this session. */
	workflowRunning: boolean;
	/** A workflow in this session is waiting for the user to answer a question. */
	waitingForInput: boolean;
	/** `provider/modelId` the session runs with. */
	model: string | null;
	thinking: ThinkingLevel | null;
	cwd: string | null;
	preview: string | null;
	/** Set when the session was started by a workflow run. */
	workflow: string | null;
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelInfo = {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow?: number;
};

export type WorkflowInfo = {
	name: string;
	description: string;
	/** JSON Schema of the input, when the workflow declares one. */
	input?: unknown;
	/** Ready-made inputs to start from, shown as one-tap choices in the clients. */
	examples?: { label: string; input: unknown }[];
	source: string;
};

export type ToolInfo = {
	name: string;
	description: string;
	source: string;
};

export type ServerState = {
	projects: ProjectInfo[];
	sessions: SessionInfo[];
	models: ModelInfo[];
	workflows: WorkflowInfo[];
	tools: ToolInfo[];
	defaults: { model: string | null; thinking: ThinkingLevel };
	version: string;
};

export type SearchHit = {
	sessionId: number;
	entryId: number;
	title: string;
	snippet: string;
	role: "user" | "assistant";
	at: number;
};

export type DirListing = {
	path: string;
	parent: string | null;
	roots: string[];
	dirs: { name: string; path: string; isProject: boolean }[];
};

export type RunStat = {
	sessionId: number;
	submissionId: number;
	model: string | null;
	status: string;
	reason: string | null;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	toolCalls: number;
	turns: number;
};

export type SendMode = "followUp" | "steer";

// ---- WebSocket ----

export type ClientMessage =
	| { t: "hello"; client: "web" | "tui"; name?: string }
	| { t: "subscribe"; sessionId: number; window?: number }
	| { t: "unsubscribe"; sessionId: number }
	| { t: "send"; sessionId: number; text: string; requestId: string; mode?: SendMode }
	| { t: "abort"; sessionId: number }
	| { t: "ping" };

export type ServerMessage =
	| { t: "state"; state: ServerState }
	| { t: "sessions"; sessions: SessionInfo[]; projects: ProjectInfo[] }
	| { t: "view"; sessionId: number; value: ConversationViewValue }
	| { t: "ops"; sessionId: number; ops: DeltaOp[] }
	| { t: "ended"; sessionId: number; reason: string }
	| { t: "error"; message: string; sessionId?: number }
	| { t: "registry"; workflows: WorkflowInfo[]; tools: ToolInfo[]; models: ModelInfo[] }
	| { t: "pong" };

/** Custom entry kinds written by the assistant (never `pi.*`). */
export const ENTRY_KINDS = {
	workflowStarted: "tiny.workflow.started",
	workflowStep: "tiny.workflow.step",
	workflowLog: "tiny.workflow.log",
	workflowRollback: "tiny.workflow.rollback",
	workflowAsk: "tiny.workflow.ask",
	workflowFinished: "tiny.workflow.finished",
} as const;

export type WorkflowStartedData = { runId: number; name: string; input: JsonLike };
export type WorkflowStepData = {
	runId: number;
	step: string;
	/**
	 * `running` when a step starts, then `done` or `failed`. During a rollback: `undoing`, then `undone` or
	 * `undo_failed`.
	 */
	status: "running" | "waiting" | "done" | "failed" | "undoing" | "undone" | "undo_failed";
	summary?: string;
	/** Display name when it differs from the step's key (questions show their text). */
	title?: string;
};

/** A workflow asks the user something and waits for the answer. */
export type WorkflowAskData = {
	runId: number;
	key: string;
	question: string;
	/** When set, the answer must be one of these. */
	choices?: string[];
	placeholder?: string;
	/** Epoch ms after which the question expires, when it has a timeout. */
	deadline?: number;
};
export type WorkflowLogData = { runId: number; text: string; level: "info" | "warn" | "error" };
/** Written when a failed or stopped run starts reverting its finished steps. */
export type WorkflowRollbackData = { runId: number; reason: string };

export type WorkflowFinishedData = {
	runId: number;
	name: string;
	status: "completed" | "failed" | "aborted";
	result?: JsonLike;
	error?: string;
	/** Steps whose undo ran after a failure or a stop, newest first. */
	rolledBack?: string[];
};
