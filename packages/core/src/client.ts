/**
 * The one client of the daemon's API, used by the web app and the TUI alike. It speaks REST for requests and keeps one
 * WebSocket for live state: the session list and the views of the sessions it follows. Runs anywhere with `fetch` and
 * `WebSocket` (browsers, Bun).
 */
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type {
	AttachmentInfo,
	ClientMessage,
	ConversationViewValue,
	DirListing,
	EngineInfo,
	ModelInfo,
	ProjectInfo,
	RunStat,
	SearchHit,
	SendMode,
	ServerMessage,
	ServerState,
	SessionInfo,
	ThinkingLevel,
	ViewEntry,
	WorkflowInfo,
} from "./protocol.ts";

export type ConnectionStatus = "connecting" | "open" | "closed";

export type SessionView = {
	sessionId: number;
	value: ConversationViewValue;
	/** Entries before the view's window, loaded on demand, oldest first. */
	earlier: ViewEntry[];
	/** Whether entries exist before `earlier` (or the window, when nothing earlier is loaded). */
	hasEarlier: boolean;
};

type Listener = () => void;

export type ClientOptions = {
	/** Base URL of the daemon, e.g. `http://mac-mini.tailnet.ts.net:7777`; empty for same-origin. */
	baseUrl?: string;
	/** Bearer token, when the daemon requires one. */
	token?: string;
	client: "web" | "tui";
	name?: string;
};

/** `crypto.randomUUID` exists only in secure contexts; a phone on plain `http://` over a tailnet has none. */
function newRequestId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export class AssistantClient {
	readonly #base: string;
	readonly #token: string | undefined;
	readonly #options: ClientOptions;
	#socket: WebSocket | undefined;
	#status: ConnectionStatus = "closed";
	#closed = false;
	#retry = 0;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#pingTimer: ReturnType<typeof setInterval> | undefined;

	state: ServerState | undefined;
	readonly views = new Map<number, SessionView>();
	readonly #subscriptions = new Set<number>();
	readonly #listeners = new Set<Listener>();
	readonly #errorListeners = new Set<(message: string, sessionId?: number) => void>();

	constructor(options: ClientOptions) {
		this.#options = options;
		this.#base = (options.baseUrl ?? "").replace(/\/$/, "");
		this.#token = options.token;
	}

	get status(): ConnectionStatus {
		return this.#status;
	}

	/** Called after every state change. Cheap: listeners re-read what they need. */
	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	onError(listener: (message: string, sessionId?: number) => void): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}

	// ---- connection ----

	connect(): void {
		this.#closed = false;
		this.#open();
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#retryTimer);
		clearInterval(this.#pingTimer);
		this.#socket?.close();
		this.#socket = undefined;
		this.#setStatus("closed");
	}

	#setStatus(status: ConnectionStatus): void {
		if (this.#status === status) return;
		this.#status = status;
		this.#emit();
	}

	#wsUrl(): string {
		const origin = this.#base || (typeof location !== "undefined" ? location.origin : "http://127.0.0.1:7777");
		const url = new URL("/ws", origin);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		if (this.#token) url.searchParams.set("token", this.#token);
		return url.toString();
	}

	#open(): void {
		this.#setStatus("connecting");
		const socket = new WebSocket(this.#wsUrl());
		this.#socket = socket;
		socket.onopen = () => {
			this.#retry = 0;
			this.#setStatus("open");
			this.#send({ t: "hello", client: this.#options.client, name: this.#options.name });
			// Re-follow every session after a reconnect; the server sends fresh views.
			for (const sessionId of this.#subscriptions) this.#send({ t: "subscribe", sessionId });
			clearInterval(this.#pingTimer);
			this.#pingTimer = setInterval(() => this.#send({ t: "ping" }), 25_000);
		};
		socket.onmessage = (event) => {
			try {
				this.#receive(JSON.parse(String(event.data)) as ServerMessage);
			} catch (error) {
				this.#fail(`Bad message from server: ${String(error)}`);
			}
		};
		socket.onclose = () => {
			clearInterval(this.#pingTimer);
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			this.#setStatus("closed");
			if (this.#closed) return;
			const delay = Math.min(10_000, 500 * 2 ** this.#retry++);
			this.#retryTimer = setTimeout(() => this.#open(), delay);
		};
		socket.onerror = () => {
			// onclose follows and schedules the retry.
		};
	}

	#send(message: ClientMessage): void {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
	}

	#fail(message: string, sessionId?: number): void {
		for (const listener of this.#errorListeners) listener(message, sessionId);
	}

	#receive(message: ServerMessage): void {
		switch (message.t) {
			case "state":
				this.state = message.state;
				break;
			case "sessions":
				if (this.state) this.state = { ...this.state, sessions: message.sessions, projects: message.projects };
				break;
			case "registry":
				if (this.state) {
					this.state = {
						...this.state,
						workflows: message.workflows,
						tools: message.tools,
						models: message.models,
						engines: message.engines,
					};
				}
				break;
			case "view": {
				const previous = this.views.get(message.sessionId);
				// After a reconnect keep earlier pages that still connect to the new window.
				const windowStart = message.value.entries[0]?.id;
				const earlier =
					previous && windowStart !== undefined
						? previous.earlier.concat(previous.value.entries).filter((entry) => entry.id < windowStart)
						: [];
				this.views.set(message.sessionId, {
					sessionId: message.sessionId,
					value: message.value,
					earlier,
					hasEarlier: earlier.length > 0 ? (previous?.hasEarlier ?? false) : message.value.before !== undefined,
				});
				break;
			}
			case "ops": {
				const view = this.views.get(message.sessionId);
				if (!view) return;
				const before = view.value.entries;
				let next: ConversationViewValue;
				try {
					next = applyImmutable(view.value, message.ops as unknown as Op[]);
				} catch {
					// Our copy diverged from the server's: drop it and ask for a fresh view.
					this.#resync(message.sessionId);
					return;
				}
				// Entries the window dropped stay visible: move them into `earlier`.
				const firstKept = next.entries[0]?.id;
				const dropped = firstKept === undefined ? [] : before.filter((entry) => entry.id < firstKept);
				const earlier = dropped.length > 0 ? view.earlier.concat(dropped) : view.earlier;
				this.views.set(message.sessionId, { ...view, value: next, earlier });
				break;
			}
			case "ended":
				// The server's watch ended (for example the daemon is restarting its harness): follow again.
				this.#resync(message.sessionId);
				break;
			case "error":
				this.#fail(message.message, message.sessionId);
				return;
			case "pong":
				return;
		}
		this.#emit();
	}

	// ---- live sessions ----

	follow(sessionId: number): void {
		if (this.#subscriptions.has(sessionId)) return;
		this.#subscriptions.add(sessionId);
		this.#send({ t: "subscribe", sessionId });
	}

	#resync(sessionId: number): void {
		this.views.delete(sessionId);
		if (!this.#subscriptions.has(sessionId)) return;
		this.#send({ t: "unsubscribe", sessionId });
		this.#send({ t: "subscribe", sessionId });
	}

	unfollow(sessionId: number): void {
		if (!this.#subscriptions.delete(sessionId)) return;
		this.#send({ t: "unsubscribe", sessionId });
		this.views.delete(sessionId);
	}

	/** All entries the client holds for a session, oldest first. */
	entries(sessionId: number): ViewEntry[] {
		const view = this.views.get(sessionId);
		if (!view) return [];
		return view.earlier.length > 0 ? view.earlier.concat(view.value.entries) : (view.value.entries as ViewEntry[]);
	}

	async loadEarlier(sessionId: number, limit = 50): Promise<void> {
		const view = this.views.get(sessionId);
		if (!view) return;
		const oldest = view.earlier[0]?.id ?? view.value.entries[0]?.id;
		if (oldest === undefined) return;
		const page = await this.#get<{ items: ViewEntry[]; hasMore: boolean }>(
			`/api/sessions/${sessionId}/entries?before=${oldest}&limit=${limit}`,
		);
		const current = this.views.get(sessionId);
		if (!current) return;
		this.views.set(sessionId, { ...current, earlier: page.items.concat(current.earlier), hasEarlier: page.hasMore });
		this.#emit();
	}

	/**
	 * Send a message. Resolves `false` when it could not be handed to the daemon (socket down and the REST fallback
	 * failed), so a composer can keep the text; the error is also reported through `onError`.
	 */
	async send(
		sessionId: number,
		text: string,
		mode: SendMode = "followUp",
		attachments: readonly string[] = [],
	): Promise<boolean> {
		const requestId = newRequestId();
		const files = attachments.length > 0 ? { attachments: [...attachments] } : {};
		if (this.#socket?.readyState === WebSocket.OPEN) {
			this.#send({ t: "send", sessionId, text, requestId, mode, ...files });
			return true;
		}
		try {
			await this.#post(`/api/sessions/${sessionId}/messages`, { text, mode, requestId, ...files });
			return true;
		} catch (error) {
			this.#fail(error instanceof Error ? error.message : String(error), sessionId);
			return false;
		}
	}

	abort(sessionId: number): void {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#send({ t: "abort", sessionId });
		else void this.#post(`/api/sessions/${sessionId}/abort`, {}).catch((error) => this.#fail(String(error), sessionId));
	}

	// ---- REST ----

	async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = {};
		const form = typeof FormData !== "undefined" && body instanceof FormData;
		if (body !== undefined && !form) headers["content-type"] = "application/json";
		if (this.#token) headers.authorization = `Bearer ${this.#token}`;
		const response = await fetch(`${this.#base}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body),
		});
		const text = await response.text();
		const json = text ? JSON.parse(text) : undefined;
		if (!response.ok) throw new ApiError(response.status, (json as { error?: string })?.error ?? response.statusText);
		return json as T;
	}

	#get<T>(path: string): Promise<T> {
		return this.#request<T>("GET", path);
	}

	#post<T>(path: string, body: unknown): Promise<T> {
		return this.#request<T>("POST", path, body);
	}

	async loadState(): Promise<ServerState> {
		this.state = await this.#get<ServerState>("/api/state");
		this.#emit();
		return this.state;
	}

	createProject(input: { path: string; name?: string; create?: boolean }): Promise<ProjectInfo> {
		return this.#post("/api/projects", input);
	}

	updateProject(id: string, change: { name?: string }): Promise<ProjectInfo> {
		return this.#request("PATCH", `/api/projects/${encodeURIComponent(id)}`, change);
	}

	deleteProject(id: string): Promise<void> {
		return this.#request("DELETE", `/api/projects/${encodeURIComponent(id)}`);
	}

	/**
	 * Start a session. `engine` picks what runs its turns (see `EngineInfo`); omitted, the daemon's default. The engine
	 * and model a session starts with become the defaults new chats preselect.
	 */
	createSession(input: {
		projectId?: string | null;
		title?: string;
		engine?: string;
		model?: string;
		thinking?: ThinkingLevel;
		text?: string;
		/** Upload IDs to attach to the first message. */
		attachments?: string[];
	}): Promise<SessionInfo> {
		return this.#post("/api/sessions", input);
	}

	updateSession(
		id: number,
		change: {
			title?: string;
			archived?: boolean;
			pinned?: boolean;
			projectId?: string | null;
			model?: string;
			thinking?: ThinkingLevel;
		},
	): Promise<SessionInfo> {
		return this.#request("PATCH", `/api/sessions/${id}`, change);
	}

	deleteSession(id: number): Promise<void> {
		return this.#request("DELETE", `/api/sessions/${id}`);
	}

	compact(id: number, instructions?: string): Promise<void> {
		return this.#post(`/api/sessions/${id}/compact`, { instructions });
	}

	reset(id: number): Promise<void> {
		return this.#post(`/api/sessions/${id}/reset`, {});
	}

	runWorkflow(input: { name: string; input?: unknown; sessionId?: number; projectId?: string | null }): Promise<{
		sessionId: number;
		runId: number;
	}> {
		return this.#post("/api/workflows/run", input);
	}

	/** Answer a question a workflow asked; the run continues with it. */
	answerWorkflow(input: { sessionId: number; runId: number; key: string; value: string }): Promise<void> {
		return this.#post(`/api/workflows/${input.runId}/answer`, input);
	}

	/**
	 * Upload files to attach to a message: send their `id`s with `send()` or `createSession()`. Images are kept as
	 * uploaded; the daemon prepares what each engine's model takes.
	 */
	upload(files: readonly (Blob & { name?: string })[]): Promise<AttachmentInfo[]> {
		const form = new FormData();
		for (const [index, file] of files.entries()) form.append("file", file, file.name || `file-${index + 1}`);
		return this.#post("/api/uploads", form);
	}

	/** Where to show or download an uploaded file (carries the token, so it works in `<img src>` and links). */
	uploadUrl(id: string, options: { download?: boolean } = {}): string {
		const params = new URLSearchParams();
		if (this.#token) params.set("token", this.#token);
		if (options.download) params.set("download", "1");
		const query = params.toString();
		return `${this.#base}/api/uploads/${encodeURIComponent(id)}${query ? `?${query}` : ""}`;
	}

	search(query: string): Promise<SearchHit[]> {
		return this.#get(`/api/search?q=${encodeURIComponent(query)}`);
	}

	listDir(path?: string): Promise<DirListing> {
		return this.#get(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
	}

	stats(sessionId?: number): Promise<RunStat[]> {
		return this.#get(`/api/stats${sessionId ? `?session=${sessionId}` : ""}`);
	}

	models(): ModelInfo[] {
		return this.state?.models ?? [];
	}

	engines(): EngineInfo[] {
		return this.state?.engines ?? [];
	}

	workflows(): WorkflowInfo[] {
		return this.state?.workflows ?? [];
	}
}
