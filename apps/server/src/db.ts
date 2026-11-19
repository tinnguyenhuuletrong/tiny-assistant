/**
 * The assistant's own tables, in the same SQLite file as pi-durable's (whose tables carry the `pi_` prefix). pi-durable
 * owns transcripts, tasks, and documents; these tables hold what the clients list and search, plus per-run metrics
 * for later analysis ("which model, how many tokens, how long, which tools").
 */
import { Database } from "bun:sqlite";
import type { AttachmentInfo, ProjectInfo, RunStat, SearchHit, SessionInfo, ThinkingLevel } from "@tiny/core/protocol";

/** An uploaded file and where its bytes are. */
export type StoredUpload = AttachmentInfo & { path: string; createdAt: number };

const MIGRATIONS: string[] = [
	`CREATE TABLE app_projects (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		path TEXT NOT NULL UNIQUE,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE app_sessions (
		id INTEGER PRIMARY KEY,
		project_id TEXT REFERENCES app_projects(id) ON DELETE SET NULL,
		title TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		archived INTEGER NOT NULL DEFAULT 0,
		pinned INTEGER NOT NULL DEFAULT 0,
		model TEXT,
		thinking TEXT,
		cwd TEXT,
		preview TEXT,
		workflow TEXT,
		indexed_entry INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX app_sessions_updated ON app_sessions(updated_at DESC);
	CREATE TABLE app_runs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id INTEGER NOT NULL,
		submission_id INTEGER NOT NULL,
		model TEXT,
		status TEXT NOT NULL,
		reason TEXT,
		started_at INTEGER NOT NULL,
		ended_at INTEGER NOT NULL,
		duration_ms INTEGER NOT NULL,
		input_tokens INTEGER NOT NULL DEFAULT 0,
		output_tokens INTEGER NOT NULL DEFAULT 0,
		cache_read_tokens INTEGER NOT NULL DEFAULT 0,
		cache_write_tokens INTEGER NOT NULL DEFAULT 0,
		cost_usd REAL NOT NULL DEFAULT 0,
		tool_calls INTEGER NOT NULL DEFAULT 0,
		turns INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX app_runs_session ON app_runs(session_id, started_at);
	CREATE TABLE app_tool_calls (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id INTEGER NOT NULL,
		entry_id INTEGER NOT NULL,
		tool TEXT NOT NULL,
		is_error INTEGER NOT NULL,
		at INTEGER NOT NULL
	);
	CREATE INDEX app_tool_calls_tool ON app_tool_calls(tool, at);
	CREATE VIRTUAL TABLE app_messages_fts USING fts5(
		text, session_id UNINDEXED, entry_id UNINDEXED, role UNINDEXED, at UNINDEXED,
		tokenize = 'porter unicode61'
	);`,
	// Engines: what runs a session's turns. Sessions from before engines ran on pi.
	`ALTER TABLE app_sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'pi';`,
	// Files users attach to messages; the bytes live under <dataDir>/uploads.
	`CREATE TABLE app_uploads (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		mime_type TEXT NOT NULL,
		size INTEGER NOT NULL,
		path TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);`,
];

type SessionRow = {
	id: number;
	project_id: string | null;
	title: string;
	created_at: number;
	updated_at: number;
	archived: number;
	pinned: number;
	model: string | null;
	thinking: string | null;
	cwd: string | null;
	preview: string | null;
	workflow: string | null;
	indexed_entry: number;
	engine: string;
};

export type IndexedMessage = { entryId: number; role: "user" | "assistant"; text: string; at: number };
export type ToolCallRecord = { entryId: number; tool: string; isError: boolean; at: number };

export class AppDb {
	readonly #db: Database;

	constructor(path: string) {
		this.#db = new Database(path, { create: true, strict: true });
		this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
		this.#migrate();
	}

	#migrate(): void {
		this.#db.exec("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const row = this.#db.query<{ value: string }, []>("SELECT value FROM app_meta WHERE key = 'schema'").get();
		let version = row ? Number(row.value) : 0;
		while (version < MIGRATIONS.length) {
			const sql = MIGRATIONS[version]!;
			this.#db.transaction(() => {
				this.#db.exec(sql);
				this.#db
					.query(
						"INSERT INTO app_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
					)
					.run(String(version + 1));
			})();
			version++;
		}
	}

	close(): void {
		this.#db.close();
	}

	// ---- settings ----

	meta(key: string): string | undefined {
		return this.#db.query<{ value: string }, [string]>("SELECT value FROM app_meta WHERE key = ?").get(key)?.value;
	}

	setMeta(key: string, value: string): void {
		this.#db
			.query("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.run(key, value);
	}

	/** The engine new chats preselect: the one the last chat was started with. */
	defaultEngine(): string | undefined {
		return this.meta("default_engine");
	}

	/** The model last used with each engine. */
	engineModels(): Record<string, string> {
		try {
			return JSON.parse(this.meta("engine_models") ?? "{}") as Record<string, string>;
		} catch {
			return {};
		}
	}

	/** Remember a choice for the next new chat: the engine, and the model used with it. */
	rememberEngine(engine: string, model: string | null, options: { asDefault: boolean }): void {
		if (options.asDefault) this.setMeta("default_engine", engine);
		if (model) this.setMeta("engine_models", JSON.stringify({ ...this.engineModels(), [engine]: model }));
	}

	// ---- projects ----

	projects(): ProjectInfo[] {
		return this.#db
			.query<{ id: string; name: string; path: string; created_at: number }, []>(
				"SELECT * FROM app_projects ORDER BY name COLLATE NOCASE",
			)
			.all()
			.map((row) => ({ id: row.id, name: row.name, path: row.path, createdAt: row.created_at }));
	}

	project(id: string): ProjectInfo | undefined {
		return this.projects().find((project) => project.id === id);
	}

	projectByPath(path: string): ProjectInfo | undefined {
		return this.projects().find((project) => project.path === path);
	}

	insertProject(project: ProjectInfo): void {
		this.#db
			.query("INSERT INTO app_projects (id, name, path, created_at) VALUES (?, ?, ?, ?)")
			.run(project.id, project.name, project.path, project.createdAt);
	}

	renameProject(id: string, name: string): void {
		this.#db.query("UPDATE app_projects SET name = ? WHERE id = ?").run(name, id);
	}

	deleteProject(id: string): void {
		this.#db.query("DELETE FROM app_projects WHERE id = ?").run(id);
	}

	// ---- sessions ----

	#toSession(row: SessionRow, busy: boolean): SessionInfo {
		return {
			id: row.id,
			projectId: row.project_id,
			title: row.title,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			archived: row.archived === 1,
			pinned: row.pinned === 1,
			busy,
			workflowRunning: false,
			waitingForInput: false,
			engine: row.engine,
			model: row.model,
			thinking: row.thinking as ThinkingLevel | null,
			cwd: row.cwd,
			preview: row.preview,
			workflow: row.workflow,
		};
	}

	sessions(busy: (id: number) => boolean, options: { archived?: boolean; limit?: number } = {}): SessionInfo[] {
		return this.#db
			.query<SessionRow, [number, number]>(
				"SELECT * FROM app_sessions WHERE archived = ? ORDER BY pinned DESC, updated_at DESC LIMIT ?",
			)
			.all(options.archived ? 1 : 0, options.limit ?? 500)
			.map((row) => this.#toSession(row, busy(row.id)));
	}

	session(id: number, busy = false): SessionInfo | undefined {
		const row = this.#db.query<SessionRow, [number]>("SELECT * FROM app_sessions WHERE id = ?").get(id);
		return row ? this.#toSession(row, busy) : undefined;
	}

	insertSession(
		session: Omit<SessionInfo, "busy" | "workflowRunning" | "waitingForInput" | "archived" | "pinned" | "preview">,
	): void {
		this.#db
			.query(
				`INSERT INTO app_sessions (id, project_id, title, created_at, updated_at, engine, model, thinking, cwd, workflow)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				session.id,
				session.projectId,
				session.title,
				session.createdAt,
				session.updatedAt,
				session.engine,
				session.model,
				session.thinking,
				session.cwd,
				session.workflow,
			);
	}

	updateSession(
		id: number,
		change: Partial<{
			title: string;
			archived: boolean;
			pinned: boolean;
			projectId: string | null;
			model: string | null;
			thinking: string | null;
			cwd: string | null;
			preview: string | null;
			updatedAt: number;
		}>,
	): void {
		const columns: Record<string, string> = {
			title: "title",
			archived: "archived",
			pinned: "pinned",
			projectId: "project_id",
			model: "model",
			thinking: "thinking",
			cwd: "cwd",
			preview: "preview",
			updatedAt: "updated_at",
		};
		const sets: string[] = [];
		const values: (string | number | null)[] = [];
		for (const [key, value] of Object.entries(change)) {
			const column = columns[key];
			if (!column || value === undefined) continue;
			sets.push(`${column} = ?`);
			values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null));
		}
		if (sets.length === 0) return;
		this.#db.query(`UPDATE app_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
	}

	indexedEntry(id: number): number {
		return (
			this.#db.query<{ indexed_entry: number }, [number]>("SELECT indexed_entry FROM app_sessions WHERE id = ?").get(id)
				?.indexed_entry ?? 0
		);
	}

	/** Index messages for search and record tool calls; one transaction, advancing the session's index mark. */
	index(sessionId: number, upTo: number, messages: IndexedMessage[], toolCalls: ToolCallRecord[]): void {
		this.#db.transaction(() => {
			const insertMessage = this.#db.query(
				"INSERT INTO app_messages_fts (text, session_id, entry_id, role, at) VALUES (?, ?, ?, ?, ?)",
			);
			for (const message of messages) {
				if (message.text.trim()) insertMessage.run(message.text, sessionId, message.entryId, message.role, message.at);
			}
			const insertTool = this.#db.query(
				"INSERT INTO app_tool_calls (session_id, entry_id, tool, is_error, at) VALUES (?, ?, ?, ?, ?)",
			);
			for (const call of toolCalls) insertTool.run(sessionId, call.entryId, call.tool, call.isError ? 1 : 0, call.at);
			this.#db.query("UPDATE app_sessions SET indexed_entry = MAX(indexed_entry, ?) WHERE id = ?").run(upTo, sessionId);
		})();
	}

	search(query: string, limit = 30): SearchHit[] {
		const terms = query
			.split(/\s+/)
			.map((term) => term.replace(/["*]/g, ""))
			.filter(Boolean)
			.map((term) => `"${term}"*`)
			.join(" ");
		if (!terms) return [];
		type Row = { session_id: number; entry_id: number; role: string; at: number; snippet: string; title: string };
		const hits = this.#db
			.query<Row, [string, number]>(
				`SELECT f.session_id, f.entry_id, f.role, f.at, s.title,
				        snippet(app_messages_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet
				 FROM app_messages_fts f JOIN app_sessions s ON s.id = f.session_id
				 WHERE app_messages_fts MATCH ? ORDER BY rank LIMIT ?`,
			)
			.all(terms, limit)
			.map((row) => ({
				sessionId: row.session_id,
				entryId: row.entry_id,
				title: row.title,
				snippet: row.snippet,
				role: row.role as "user" | "assistant",
				at: row.at,
			}));
		// Title matches too, for sessions whose text is not indexed yet.
		const titles = this.#db
			.query<SessionRow, [string]>("SELECT * FROM app_sessions WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 10")
			.all(`%${query}%`)
			.filter((row) => !hits.some((hit) => hit.sessionId === row.id))
			.map((row) => ({
				sessionId: row.id,
				entryId: 0,
				title: row.title,
				snippet: row.preview ?? "",
				role: "user" as const,
				at: row.updated_at,
			}));
		return [...titles, ...hits];
	}

	// ---- uploads ----

	insertUpload(upload: StoredUpload): void {
		this.#db
			.query("INSERT INTO app_uploads (id, name, mime_type, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(upload.id, upload.name, upload.mimeType, upload.size, upload.path, upload.createdAt);
	}

	upload(id: string): StoredUpload | undefined {
		type Row = { id: string; name: string; mime_type: string; size: number; path: string; created_at: number };
		const row = this.#db.query<Row, [string]>("SELECT * FROM app_uploads WHERE id = ?").get(id);
		return row
			? {
					id: row.id,
					name: row.name,
					mimeType: row.mime_type,
					size: row.size,
					path: row.path,
					createdAt: row.created_at,
				}
			: undefined;
	}

	// ---- runs ----

	insertRun(run: RunStat): void {
		this.#db
			.query(
				`INSERT INTO app_runs (session_id, submission_id, model, status, reason, started_at, ended_at, duration_ms,
				   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, tool_calls, turns)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				run.sessionId,
				run.submissionId,
				run.model,
				run.status,
				run.reason,
				run.startedAt,
				run.endedAt,
				run.durationMs,
				run.inputTokens,
				run.outputTokens,
				run.cacheReadTokens,
				run.cacheWriteTokens,
				run.costUsd,
				run.toolCalls,
				run.turns,
			);
	}

	runs(sessionId: number | undefined, limit = 200): RunStat[] {
		type Row = Record<string, number | string | null>;
		const rows = sessionId
			? this.#db
					.query<Row, [number, number]>("SELECT * FROM app_runs WHERE session_id = ? ORDER BY id DESC LIMIT ?")
					.all(sessionId, limit)
			: this.#db.query<Row, [number]>("SELECT * FROM app_runs ORDER BY id DESC LIMIT ?").all(limit);
		return rows.map((row) => ({
			sessionId: Number(row.session_id),
			submissionId: Number(row.submission_id),
			model: (row.model as string | null) ?? null,
			status: String(row.status),
			reason: (row.reason as string | null) ?? null,
			startedAt: Number(row.started_at),
			endedAt: Number(row.ended_at),
			durationMs: Number(row.duration_ms),
			inputTokens: Number(row.input_tokens),
			outputTokens: Number(row.output_tokens),
			cacheReadTokens: Number(row.cache_read_tokens),
			cacheWriteTokens: Number(row.cache_write_tokens),
			costUsd: Number(row.cost_usd),
			toolCalls: Number(row.tool_calls),
			turns: Number(row.turns),
		}));
	}
}
