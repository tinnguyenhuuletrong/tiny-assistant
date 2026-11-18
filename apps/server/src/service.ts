/**
 * The daemon's heart: one pi-durable Harness over one SQLite file, the session catalog around it, and live feeds that
 * fan each conversation's committed changes out to every connected client.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
	type Conversation,
	type ConversationView,
	type ConversationWatch,
	createRegistry,
	Harness,
	LiveDoc,
	type Registry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type {
	ConversationViewValue,
	DeltaOp,
	ModelInfo,
	ProjectInfo,
	SendMode,
	ServerState,
	SessionInfo,
	ThinkingLevel,
	ViewEntry,
} from "@tiny/core/protocol";
import type { Config } from "./config.ts";
import { AppDb, type IndexedMessage, type ToolCallRecord } from "./db.ts";
import { UserCodeLoader } from "./loader.ts";
import { availableModels, createModelRegistry, parseModelKey, pickDefaultModel } from "./models.ts";
import { createPromptExtension } from "./prompt.ts";
import {
	AnswersDoc,
	createWorkflowExtension,
	createWorkflowTask,
	QuestionTask,
	WorkflowAsk,
	WorkflowCatalog,
	WorkflowStarted,
	type WorkflowTaskDef,
} from "./workflows.ts";

const context = BACKGROUND_CONTEXT;
export const VERSION = "0.1.0";

export type FeedListener = (message: { t: "ops"; ops: DeltaOp[] } | { t: "ended"; reason: string }) => void;

/** One conversation watch shared by every client following the session, plus busy tracking. */
type Feed = {
	readonly sessionId: number;
	readonly watch: ConversationWatch;
	latest: ConversationView;
	readonly listeners: Set<FeedListener>;
	busy: boolean;
	runStartedAt: number;
	runInputs: number[];
	idleTimer?: ReturnType<typeof setTimeout>;
};

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function titleFrom(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	const clean = line
		.replace(/^[#>\s]+/, "")
		.replace(/[*`]/g, "")
		.trim();
	return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean || "New chat";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => (part as { type?: string }).type === "text")
		.map((part) => (part as { text: string }).text)
		.join("");
}

export class AssistantService {
	readonly db: AppDb;
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly registry: Registry;
	readonly workflows: WorkflowCatalog;
	readonly loader: UserCodeLoader;
	readonly #workflowTask: WorkflowTaskDef;
	modelList: ModelInfo[] = [];
	defaultModel: string | null = null;

	/** Feeds being opened or open, by session. */
	readonly #feeds = new Map<number, Promise<Feed>>();
	/** The open feed of each session, so stale cleanup never removes a newer feed. */
	readonly #openFeeds = new Map<number, Feed>();
	/** Index runs per session, chained so two never read the same mark and insert the same rows. */
	readonly #indexing = new Map<number, Promise<void>>();
	readonly #busy = new Set<number>();
	readonly #runningWorkflows = new Map<number, Set<number>>();
	/** Questions waiting for an answer, per session, as `<runId>:<key>`. */
	readonly #waiting = new Map<number, Set<string>>();
	readonly #sessionsListeners = new Set<() => void>();
	readonly #registryListeners = new Set<() => void>();
	#sessionsTimer: ReturnType<typeof setTimeout> | undefined;
	#closing = false;

	private constructor(
		readonly config: Config,
		parts: {
			db: AppDb;
			harness: Harness;
			models: MutableModels;
			registry: Registry;
			workflows: WorkflowCatalog;
			loader: UserCodeLoader;
			workflowTask: WorkflowTaskDef;
		},
	) {
		this.db = parts.db;
		this.harness = parts.harness;
		this.models = parts.models;
		this.registry = parts.registry;
		this.workflows = parts.workflows;
		this.loader = parts.loader;
		this.#workflowTask = parts.workflowTask;
	}

	/** `options.models` replaces the configured providers (tests pass pi-ai's faux provider). */
	static async open(config: Config, options: { models?: MutableModels } = {}): Promise<AssistantService> {
		mkdirSync(config.dataDir, { recursive: true });
		const dbPath = join(config.dataDir, "assistant.sqlite");
		const db = new AppDb(dbPath);
		const models = options.models ?? createModelRegistry(config.providers);
		const registry = createRegistry();
		const workflows = new WorkflowCatalog();
		const cwdOf = (sessionId: number) => db.session(sessionId)?.cwd ?? undefined;
		let service: AssistantService | undefined;
		const workflowTask = createWorkflowTask(workflows, cwdOf, {
			waiting: (sessionId, runId, key, open) => service?.setWaiting(sessionId, `${runId}:${key}`, open),
		});

		registry.install(CodingTools);
		registry.install(createPromptExtension(config.assistantDir));
		registry.install(createWorkflowExtension(workflowTask));

		const loader = new UserCodeLoader(config.assistantDir, registry, workflows, () => service?.notifyRegistryChanged());
		await loader.loadAll();

		const storage = await openNodeSqliteStorage(dbPath, { prefix: "pi_" });
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				identity: {
					attribution: { name: "tiny-assistant", url: "https://github.com/tinnguyenhuuletrong/tiny-assistant" },
				},
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? homedir() }),
				settings: {
					retry: { maxRetries: 3 },
					toolExecution: "parallel",
					afterFailedRun: "continue",
				},
				onReport: (report) => {
					console.warn(
						`[durable] ${report.kind}: ${report.error instanceof Error ? report.error.message : report.error}`,
					);
				},
			},
			context,
		);

		service = new AssistantService(config, { db, harness, models, registry, workflows, loader, workflowTask });
		await service.refreshModels();
		loader.watch();
		harness.resume();
		await service.#reattachBusySessions();
		return service;
	}

	async close(): Promise<void> {
		this.#closing = true;
		clearTimeout(this.#sessionsTimer);
		this.loader.close();
		for (const pending of this.#feeds.values()) {
			const feed = await pending.catch(() => undefined);
			await feed?.watch.stop();
		}
		await this.harness.close(context);
		this.db.close();
	}

	async refreshModels(): Promise<void> {
		try {
			this.modelList = await availableModels(this.models);
		} catch (error) {
			console.warn(`[models] discovery failed: ${error}`);
		}
		this.defaultModel = pickDefaultModel(this.modelList, this.config.defaultModel);
		console.log(`[models] ${this.modelList.length} available; default ${this.defaultModel ?? "(none)"}`);
		this.notifyRegistryChanged();
	}

	// ---- change notifications ----

	onSessionsChanged(listener: () => void): () => void {
		this.#sessionsListeners.add(listener);
		return () => this.#sessionsListeners.delete(listener);
	}

	onRegistryChanged(listener: () => void): () => void {
		this.#registryListeners.add(listener);
		return () => this.#registryListeners.delete(listener);
	}

	#sessionsChanged(): void {
		clearTimeout(this.#sessionsTimer);
		if (this.#closing) return;
		this.#sessionsTimer = setTimeout(() => {
			for (const listener of this.#sessionsListeners) listener();
		}, 30);
	}

	notifyRegistryChanged(): void {
		for (const listener of this.#registryListeners) listener();
	}

	// ---- state ----

	isBusy(sessionId: number): boolean {
		return this.#busy.has(sessionId) || (this.#runningWorkflows.get(sessionId)?.size ?? 0) > 0;
	}

	sessions(): SessionInfo[] {
		return this.db.sessions((id) => this.isBusy(id)).map((session) => this.#withActivity(session));
	}

	session(id: number): SessionInfo | undefined {
		const session = this.db.session(id, this.isBusy(id));
		return session && this.#withActivity(session);
	}

	#withActivity(session: SessionInfo): SessionInfo {
		const workflowRunning = (this.#runningWorkflows.get(session.id)?.size ?? 0) > 0;
		const waitingForInput = (this.#waiting.get(session.id)?.size ?? 0) > 0;
		return workflowRunning || waitingForInput ? { ...session, workflowRunning, waitingForInput } : session;
	}

	/** Called by the workflow engine when a question starts or stops waiting. */
	setWaiting(sessionId: number, question: string, open: boolean): void {
		let set = this.#waiting.get(sessionId);
		if (open) {
			if (!set) {
				set = new Set();
				this.#waiting.set(sessionId, set);
			}
			if (set.has(question)) return;
			set.add(question);
		} else if (!set?.delete(question)) return;
		this.#sessionsChanged();
	}

	state(): ServerState {
		return {
			projects: this.db.projects(),
			sessions: this.sessions(),
			models: this.modelList,
			workflows: this.workflows.list(),
			tools: this.tools(),
			defaults: { model: this.defaultModel, thinking: "medium" },
			version: VERSION,
		};
	}

	tools() {
		const builtin = ["read", "write", "edit", "bash"].map((name) => ({
			name,
			description: `Built-in ${name} tool`,
			source: "builtin",
		}));
		return [...builtin, ...this.loader.tools()];
	}

	// ---- projects ----

	createProject(input: { path: string; name?: string; create?: boolean }): ProjectInfo {
		const path = resolve(input.path.startsWith("~") ? join(homedir(), input.path.slice(1)) : input.path);
		if (!this.isAllowedPath(path)) throw new HttpError(403, "That folder is outside the allowed roots");
		if (!existsSync(path)) {
			if (!input.create) throw new HttpError(404, "Folder does not exist");
			mkdirSync(path, { recursive: true });
		}
		if (!statSync(path).isDirectory()) throw new HttpError(400, "Not a folder");
		const existing = this.db.projectByPath(path);
		if (existing) return existing;
		const project: ProjectInfo = {
			id: crypto.randomUUID().slice(0, 8),
			name: input.name?.trim() || basename(path),
			path,
			createdAt: Date.now(),
		};
		this.db.insertProject(project);
		this.#sessionsChanged();
		return project;
	}

	renameProject(id: string, name: string): ProjectInfo {
		const project = this.db.project(id);
		if (!project) throw new HttpError(404, "No such project");
		this.db.renameProject(id, name.trim() || project.name);
		this.#sessionsChanged();
		return this.db.project(id)!;
	}

	deleteProject(id: string): void {
		this.db.deleteProject(id);
		this.#sessionsChanged();
	}

	isAllowedPath(path: string): boolean {
		const target = resolve(path);
		return this.config.fsRoots.some((root) => target === root || target.startsWith(`${root}/`));
	}

	// ---- sessions ----

	async #conversation(id: number): Promise<Conversation> {
		if (!this.db.session(id)) throw new HttpError(404, `No session ${id}`);
		const conversation = await this.harness.conversation(id as never, context);
		if (!conversation) throw new HttpError(404, `No conversation ${id}`);
		return conversation;
	}

	async createSession(input: {
		projectId?: string | null;
		title?: string;
		model?: string;
		thinking?: ThinkingLevel;
		text?: string;
		workflow?: string;
	}): Promise<SessionInfo> {
		const project = input.projectId ? this.db.project(input.projectId) : undefined;
		if (input.projectId && !project) throw new HttpError(404, "No such project");
		const model = input.model ?? this.defaultModel;
		if (!model) throw new HttpError(503, "No model available. Is Claude Code installed and logged in?");
		const thinking = input.thinking ?? "medium";
		const conversation = await this.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: parseModelKey(model), thinkingLevel: thinking, ...(project ? { cwd: project.path } : {}) },
			},
			context,
		);
		const now = Date.now();
		const id = Number(conversation.id);
		this.db.insertSession({
			id,
			projectId: project?.id ?? null,
			title: input.title?.trim() || (input.text ? titleFrom(input.text) : "New chat"),
			createdAt: now,
			updatedAt: now,
			model,
			thinking,
			cwd: project?.path ?? null,
			workflow: input.workflow ?? null,
		});
		if (input.text?.trim()) await this.send(id, input.text, "followUp", crypto.randomUUID());
		this.#sessionsChanged();
		return this.session(id)!;
	}

	async updateSession(
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
		const conversation = await this.#conversation(id);
		const agent: Record<string, unknown> = {};
		const row: Parameters<AppDb["updateSession"]>[1] = {};
		if (change.title !== undefined) row.title = change.title.trim() || "Untitled";
		if (change.archived !== undefined) row.archived = change.archived;
		if (change.pinned !== undefined) row.pinned = change.pinned;
		if (change.model !== undefined) {
			agent.model = parseModelKey(change.model);
			row.model = change.model;
		}
		if (change.thinking !== undefined) {
			agent.thinkingLevel = change.thinking;
			row.thinking = change.thinking;
		}
		if (change.projectId !== undefined) {
			const project = change.projectId ? this.db.project(change.projectId) : undefined;
			if (change.projectId && !project) throw new HttpError(404, "No such project");
			row.projectId = project?.id ?? null;
			row.cwd = project?.path ?? null;
			agent.cwd = project?.path ?? null;
		}
		if (Object.keys(agent).length > 0) await conversation.configure(agent as never, context);
		this.db.updateSession(id, row);
		this.#sessionsChanged();
		return this.session(id)!;
	}

	async send(id: number, text: string, mode: SendMode, requestId: string): Promise<void> {
		const content = text.trim();
		if (!content) throw new HttpError(400, "Empty message");
		const conversation = await this.#conversation(id);
		await this.#feed(id); // follow it, so busy state and indexing track the run
		await conversation.submit(
			{ type: "input", content, requestId, ...(mode === "steer" ? { whenBusy: "steer" as const } : {}) },
			context,
		);
		const session = this.db.session(id);
		this.db.updateSession(id, {
			updatedAt: Date.now(),
			preview: content.slice(0, 160),
			...(session?.title === "New chat" ? { title: titleFrom(content) } : {}),
		});
		this.#sessionsChanged();
	}

	async abort(id: number): Promise<void> {
		const conversation = await this.#conversation(id);
		await conversation.abort(context);
	}

	async compact(id: number, instructions?: string): Promise<void> {
		const conversation = await this.#conversation(id);
		await this.#feed(id);
		await conversation.compact(instructions, context);
	}

	async reset(id: number): Promise<void> {
		const conversation = await this.#conversation(id);
		await conversation.reset(undefined, context);
	}

	async entries(
		id: number,
		before: number | undefined,
		limit: number,
	): Promise<{ items: ViewEntry[]; hasMore: boolean }> {
		const conversation = await this.#conversation(id);
		const page = await conversation.entries(
			before === undefined ? {} : { maxEntryId: (before - 1) as never },
			Math.min(Math.max(limit, 1), 200),
			undefined,
			context,
		);
		return { items: [...page.items].reverse() as unknown as ViewEntry[], hasMore: page.next !== undefined };
	}

	// ---- workflows ----

	async runWorkflow(input: {
		name: string;
		input?: unknown;
		sessionId?: number;
		projectId?: string | null;
	}): Promise<{ sessionId: number; runId: number }> {
		const def = this.workflows.get(input.name);
		if (!def) throw new HttpError(404, `No workflow "${input.name}"`);
		let validated: JsonValue;
		try {
			validated = this.workflows.validate(input.name, input.input);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		const sessionId =
			input.sessionId ??
			(await this.createSession({ projectId: input.projectId, title: `⚙ ${def.name}`, workflow: def.name })).id;
		const conversation = await this.#conversation(sessionId);
		await this.#feed(sessionId);
		const taskId = await conversation.commit(async (tx) => {
			const id = await tx.createTask(
				this.#workflowTask,
				{ name: def.name, input: validated },
				{ ownership: { kind: "conversation" } },
			);
			await tx.appendEntry(conversation.id, {
				kind: WorkflowStarted.kind,
				data: { runId: Number(id), name: def.name, input: validated },
			});
			return id;
		}, context);
		this.#trackWorkflow(sessionId, Number(taskId));
		this.db.updateSession(sessionId, { updatedAt: Date.now(), preview: `Workflow ${def.name}` });
		this.#sessionsChanged();
		return { sessionId, runId: Number(taskId) };
	}

	#trackWorkflow(sessionId: number, runId: number): void {
		let runs = this.#runningWorkflows.get(sessionId);
		if (!runs) {
			runs = new Set();
			this.#runningWorkflows.set(sessionId, runs);
		}
		runs.add(runId);
		this.#sessionsChanged();
		void this.harness
			.waitForTask(runId as never, context)
			.catch(() => undefined)
			.finally(() => {
				runs.delete(runId);
				const waiting = this.#waiting.get(sessionId);
				for (const question of waiting ?? []) if (question.startsWith(`${runId}:`)) waiting?.delete(question);
				this.#sessionsChanged();
				void this.#indexSession(sessionId, undefined);
			});
	}

	/** Every question task (optionally of one session), through all pages. */
	async #questionTasks(
		sessionId?: number,
	): Promise<{ taskId: number; sessionId: number; runId: number; key: string; live: boolean }[]> {
		return this.harness.commit(async (tx) => {
			const found: { taskId: number; sessionId: number; runId: number; key: string; live: boolean }[] = [];
			let cursor: Parameters<typeof tx.scanTasks>[2];
			do {
				const page = await tx.scanTasks(
					{
						kind: QuestionTask.definition.name,
						...(sessionId === undefined ? {} : { conversationId: sessionId as never }),
					},
					500,
					cursor,
				);
				for (const task of page.items) {
					const input = task.input as { runId: number; key: string };
					found.push({
						taskId: Number(task.id),
						sessionId: Number(task.conversationId),
						runId: input.runId,
						key: input.key,
						live: task.state.status !== "terminal",
					});
				}
				cursor = page.next;
			} while (cursor !== undefined);
			return found;
		}, context);
	}

	/** The live question task of a workflow ask, if the run is still waiting for it. */
	async #liveQuestion(sessionId: number, runId: number, key: string): Promise<number | undefined> {
		const questions = await this.#questionTasks(sessionId);
		return questions.find((question) => question.live && question.runId === runId && question.key === key)?.taskId;
	}

	/**
	 * Answer a workflow's question. The answer is stored first (first answer wins), then the question task is ended,
	 * which wakes the run. If the daemon dies in between, startup finishes the delivery.
	 */
	async answerWorkflow(input: { sessionId: number; runId: number; key: string; value: string }): Promise<void> {
		const conversation = await this.#conversation(input.sessionId);
		const value = String(input.value ?? "").trim();
		if (!value) throw new HttpError(400, "Empty answer");
		let ask: { choices?: string[] } | undefined;
		let cursor: unknown;
		do {
			const page = await conversation.entries({}, 200, cursor as never, context);
			const found = page.items.find((entry) => {
				const data = entry.data as { runId?: number; key?: string } | undefined;
				return entry.kind === WorkflowAsk.kind && data?.runId === input.runId && data?.key === input.key;
			});
			if (found) ask = found.data as { choices?: string[] };
			cursor = page.next;
		} while (!ask && cursor !== undefined);
		if (!ask) throw new HttpError(404, "No such question");
		if (ask.choices?.length && !ask.choices.includes(value)) {
			throw new HttpError(400, `Answer must be one of: ${ask.choices.join(", ")}`);
		}
		const questionTaskId = await this.#liveQuestion(input.sessionId, input.runId, input.key);
		if (questionTaskId === undefined) throw new HttpError(409, "This question is no longer waiting for an answer");
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(AnswersDoc, conversation.id);
			const slot = `${input.runId}:${input.key}`;
			if (doc.answers[slot] !== undefined) throw new HttpError(409, "Already answered");
			doc.answers[slot] = value;
		}, context);
		// The deadline may have passed meanwhile; then the run treats the question as expired, whatever was stored.
		const ended = await this.harness.abortTask(questionTaskId as never, context).catch(() => "terminal" as const);
		if (ended === "terminal") throw new HttpError(409, "This question expired before the answer arrived");
	}

	// ---- live feeds ----

	/** Follow a session's view. The listener gets ops after the returned value; call the returned function to stop. */
	async follow(id: number, listener: FeedListener): Promise<{ value: ConversationViewValue; stop: () => void }> {
		await this.#conversation(id);
		const feed = await this.#feed(id);
		clearTimeout(feed.idleTimer);
		feed.listeners.add(listener);
		return {
			value: feed.latest as unknown as ConversationViewValue,
			stop: () => {
				feed.listeners.delete(listener);
				this.#maybeRelease(feed);
			},
		};
	}

	#feed(id: number): Promise<Feed> {
		let pending = this.#feeds.get(id);
		if (pending) return pending;
		pending = this.#openFeed(id);
		this.#feeds.set(id, pending);
		const opening = pending;
		opening.catch(() => {
			if (this.#feeds.get(id) === opening) this.#feeds.delete(id);
		});
		return pending;
	}

	/** Drop a feed from the maps, unless a newer feed for the same session replaced it. */
	#forget(feed: Feed): void {
		if (this.#openFeeds.get(feed.sessionId) !== feed) return;
		this.#openFeeds.delete(feed.sessionId);
		this.#feeds.delete(feed.sessionId);
	}

	async #openFeed(id: number): Promise<Feed> {
		const conversation = await this.harness.conversation(id as never, context);
		if (!conversation) throw new HttpError(404, `No conversation ${id}`);
		const watch = await conversation.watch(context, { min: 60, max: 160 });
		const feed: Feed = {
			sessionId: id,
			watch,
			latest: watch.value,
			listeners: new Set(),
			busy: false,
			runStartedAt: 0,
			runInputs: [],
		};
		this.#openFeeds.set(id, feed);
		this.#observeBusy(feed);
		// A feed opened for a send, compact, or workflow may never become busy: let it go once nobody needs it.
		this.#maybeRelease(feed);
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			feed.latest = call.value;
			const ops = call.ops as unknown as DeltaOp[];
			for (const listener of feed.listeners) listener({ t: "ops", ops });
			this.#observeBusy(feed);
		});
		void watch.closed.then((end) => {
			clearTimeout(feed.idleTimer);
			this.#forget(feed);
			for (const listener of feed.listeners) listener({ t: "ended", reason: end.kind });
		});
		return feed;
	}

	#observeBusy(feed: Feed): void {
		const live = feed.latest.docs["pi.live"] as { run?: { inputs?: number[] } } | undefined;
		const busy = live?.run !== undefined;
		if (busy && live?.run?.inputs?.length) feed.runInputs = live.run.inputs;
		if (busy === feed.busy) return;
		feed.busy = busy;
		if (busy) {
			feed.runStartedAt = Date.now();
			this.#busy.add(feed.sessionId);
		} else {
			this.#busy.delete(feed.sessionId);
			void this.#indexSession(feed.sessionId, feed);
			this.#maybeRelease(feed);
		}
		this.#sessionsChanged();
	}

	#maybeRelease(feed: Feed): void {
		if (feed.listeners.size > 0 || feed.busy) return;
		clearTimeout(feed.idleTimer);
		feed.idleTimer = setTimeout(() => {
			if (feed.listeners.size > 0 || feed.busy) return;
			this.#forget(feed);
			void feed.watch.stop();
		}, 60_000);
	}

	/**
	 * After a restart, follow sessions whose runs pi-durable resumed, and track resumed workflow runs, so clients show
	 * them as busy (with a Stop button) and their end is indexed.
	 */
	async #reattachBusySessions(): Promise<void> {
		for (const session of this.db.sessions(() => false, { limit: 200 })) {
			const live = await this.harness.snapshot(LiveDoc, session.id as never, context).catch(() => undefined);
			if (live?.run) await this.#feed(session.id).catch(() => undefined);
		}
		const runs = await this.harness
			.commit(async (tx) => {
				const found: { sessionId: number; runId: number }[] = [];
				let cursor: Parameters<typeof tx.scanTasks>[2];
				do {
					const page = await tx.scanTasks({ kind: this.#workflowTask.definition.name }, 200, cursor);
					for (const task of page.items) {
						if (task.state.status !== "terminal")
							found.push({ sessionId: Number(task.conversationId), runId: Number(task.id) });
					}
					cursor = page.next;
				} while (cursor !== undefined);
				return found;
			}, context)
			.catch((error) => {
				console.warn(`[workflows] could not list resumed runs: ${error}`);
				return [];
			});
		for (const run of runs) this.#trackWorkflow(run.sessionId, run.runId);

		const questions = (await this.#questionTasks().catch(() => [])).filter((question) => question.live);
		for (const question of questions) {
			const answers = await this.harness
				.snapshot(AnswersDoc, question.sessionId as never, context)
				.catch(() => undefined);
			if (answers?.answers[`${question.runId}:${question.key}`] !== undefined) {
				// Answered, but the daemon stopped before the run was woken: finish the delivery.
				await this.harness.abortTask(question.taskId as never, context).catch(() => undefined);
			} else this.setWaiting(question.sessionId, `${question.runId}:${question.key}`, true);
		}
	}

	// ---- indexing and run metrics ----

	#indexSession(id: number, feed: Feed | undefined): Promise<void> {
		const previous = this.#indexing.get(id) ?? Promise.resolve();
		const next = previous.then(() => this.#indexSessionNow(id, feed));
		this.#indexing.set(id, next);
		void next.finally(() => {
			if (this.#indexing.get(id) === next) this.#indexing.delete(id);
		});
		return next;
	}

	async #indexSessionNow(id: number, feed: Feed | undefined): Promise<void> {
		if (this.#closing) return;
		try {
			const conversation = await this.harness.conversation(id as never, context);
			if (!conversation) return;
			const mark = this.db.indexedEntry(id);
			const entries: ViewEntry[] = [];
			let cursor: unknown;
			do {
				const page = await conversation.entries(
					{ minEntryId: (mark + 1) as never, order: "ascending" },
					200,
					cursor as never,
					context,
				);
				entries.push(...(page.items as unknown as ViewEntry[]));
				cursor = page.next;
			} while (cursor !== undefined && entries.length < 5000);
			if (entries.length === 0) return;

			const messages: IndexedMessage[] = [];
			const toolCalls: ToolCallRecord[] = [];
			const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
			let model: string | null = null;
			let lastAnswer = "";
			for (const entry of entries) {
				const message = entry.model?.[0] as Record<string, unknown> | undefined;
				if (!message) continue;
				const at = Number(message.timestamp ?? Date.now());
				if (message.role === "user") {
					messages.push({ entryId: entry.id, role: "user", text: textOf(message.content), at });
				} else if (message.role === "assistant") {
					const text = textOf(message.content);
					if (text) {
						messages.push({ entryId: entry.id, role: "assistant", text, at });
						lastAnswer = text;
					}
					const usage = message.usage as Record<string, number> & { cost?: { total?: number } };
					if (usage) {
						totals.input += usage.input ?? 0;
						totals.output += usage.output ?? 0;
						totals.cacheRead += usage.cacheRead ?? 0;
						totals.cacheWrite += usage.cacheWrite ?? 0;
						totals.cost += usage.cost?.total ?? 0;
					}
					totals.turns++;
					model = `${String(message.provider)}/${String(message.model)}`;
				} else if (message.role === "toolResult") {
					toolCalls.push({ entryId: entry.id, tool: String(message.toolName), isError: Boolean(message.isError), at });
				}
			}
			const upTo = entries[entries.length - 1]!.id;
			this.db.index(id, upTo, messages, toolCalls);

			if (feed && totals.turns > 0) {
				const live = feed.latest.docs["pi.live"] as { runFailure?: { reason: string } } | undefined;
				const endedAt = Date.now();
				this.db.insertRun({
					sessionId: id,
					submissionId: feed.runInputs[0] ?? 0,
					model,
					status: live?.runFailure ? "unanswered" : "done",
					reason: live?.runFailure?.reason ?? null,
					startedAt: feed.runStartedAt || endedAt,
					endedAt,
					durationMs: feed.runStartedAt ? endedAt - feed.runStartedAt : 0,
					inputTokens: totals.input,
					outputTokens: totals.output,
					cacheReadTokens: totals.cacheRead,
					cacheWriteTokens: totals.cacheWrite,
					costUsd: totals.cost,
					toolCalls: toolCalls.length,
					turns: totals.turns,
				});
			}
			if (lastAnswer) {
				this.db.updateSession(id, { preview: lastAnswer.replace(/\s+/g, " ").slice(0, 160), updatedAt: Date.now() });
				this.#sessionsChanged();
			}
		} catch (error) {
			console.warn(`[index] session ${id}: ${error}`);
		}
	}
}
