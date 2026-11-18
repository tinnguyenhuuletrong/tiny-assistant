/**
 * The daemon's API: REST under `/api`, the live WebSocket at `/ws`, and the built web app for everything else.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ClientMessage, DirListing, ServerMessage } from "@tiny/core/protocol";
import type { Server, ServerWebSocket } from "bun";
import { authorize } from "./auth.ts";
import { type AssistantService, HttpError } from "./service.ts";

type SocketData = { follows: Map<number, () => void>; client: string; login: string | undefined };

const ALL = "all";

function json(value: unknown, status = 200): Response {
	return new Response(value === undefined ? null : JSON.stringify(value), {
		status: value === undefined && status === 200 ? 204 : status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

function errorResponse(error: unknown): Response {
	if (error instanceof HttpError) return json({ error: error.message }, error.status);
	console.error("[http]", error);
	return json({ error: error instanceof Error ? error.message : String(error) }, 500);
}

async function body<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw new HttpError(400, "Expected a JSON body");
	}
}

function intParam(value: string | null | undefined, name: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number <= 0) throw new HttpError(400, `Bad ${name}`);
	return number;
}

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "AGENTS.md", "CLAUDE.md"];

function listDir(service: AssistantService, requested: string | null): DirListing {
	const roots = service.config.fsRoots;
	const path = resolve(requested || roots[0]!);
	if (!service.isAllowedPath(path)) throw new HttpError(403, "That folder is outside the allowed roots");
	if (!existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(404, "Not a folder");
	const dirs = readdirSync(path, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
		.map((entry) => {
			const full = join(path, entry.name);
			let isProject = false;
			try {
				isProject = PROJECT_MARKERS.some((marker) => existsSync(join(full, marker)));
			} catch {}
			return { name: entry.name, path: full, isProject };
		})
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
	const parent = dirname(path);
	return { path, parent: parent !== path && service.isAllowedPath(parent) ? parent : null, roots, dirs };
}

export function startServer(service: AssistantService): Server<SocketData> {
	const config = service.config;
	const webDir = config.webDir && existsSync(join(config.webDir, "index.html")) ? config.webDir : undefined;

	const handlers: Record<
		string,
		Record<string, (request: Request, url: URL, params: string[]) => Promise<Response>>
	> = {
		"/api/state": { GET: async () => json(service.state()) },
		"/api/models/refresh": {
			POST: async () => {
				await service.refreshModels();
				return json(service.modelList);
			},
		},
		"/api/projects": {
			GET: async () => json(service.db.projects()),
			POST: async (request) => json(service.createProject(await body(request)), 201),
		},
		"/api/projects/:id": {
			PATCH: async (request, _url, [id]) =>
				json(service.renameProject(id!, (await body<{ name: string }>(request)).name)),
			DELETE: async (_request, _url, [id]) => {
				service.deleteProject(id!);
				return json(undefined);
			},
		},
		"/api/sessions": {
			GET: async () => json(service.sessions()),
			POST: async (request) => json(await service.createSession(await body(request)), 201),
		},
		"/api/sessions/:id": {
			PATCH: async (request, _url, [id]) => json(await service.updateSession(intParam(id, "id"), await body(request))),
			DELETE: async (_request, _url, [id]) => {
				await service.updateSession(intParam(id, "id"), { archived: true });
				return json(undefined);
			},
		},
		"/api/sessions/:id/messages": {
			POST: async (request, _url, [id]) => {
				const input = await body<{ text: string; mode?: "followUp" | "steer"; requestId?: string }>(request);
				await service.send(
					intParam(id, "id"),
					input.text,
					input.mode ?? "followUp",
					input.requestId ?? crypto.randomUUID(),
				);
				return json({ ok: true }, 202);
			},
		},
		"/api/sessions/:id/abort": {
			POST: async (_request, _url, [id]) => {
				await service.abort(intParam(id, "id"));
				return json({ ok: true });
			},
		},
		"/api/sessions/:id/compact": {
			POST: async (request, _url, [id]) => {
				const input = await body<{ instructions?: string }>(request).catch(() => ({}) as { instructions?: string });
				await service.compact(intParam(id, "id"), input.instructions);
				return json({ ok: true }, 202);
			},
		},
		"/api/sessions/:id/reset": {
			POST: async (_request, _url, [id]) => {
				await service.reset(intParam(id, "id"));
				return json({ ok: true });
			},
		},
		"/api/sessions/:id/entries": {
			GET: async (_request, url, [id]) => {
				const before = url.searchParams.get("before");
				const limit = Number(url.searchParams.get("limit") ?? 50);
				return json(await service.entries(intParam(id, "id"), before ? intParam(before, "before") : undefined, limit));
			},
		},
		"/api/workflows": { GET: async () => json(service.workflows.list()) },
		"/api/workflows/run": { POST: async (request) => json(await service.runWorkflow(await body(request)), 202) },
		"/api/search": {
			GET: async (_request, url) => json(service.db.search((url.searchParams.get("q") ?? "").slice(0, 200))),
		},
		"/api/fs": { GET: async (_request, url) => json(listDir(service, url.searchParams.get("path"))) },
		"/api/stats": {
			GET: async (_request, url) => {
				const session = url.searchParams.get("session");
				return json(service.db.runs(session ? intParam(session, "session") : undefined));
			},
		},
		"/api/health": { GET: async () => json({ ok: true, version: service.state().version }) },
	};

	const routes = Object.entries(handlers).map(([pattern, methods]) => ({
		regex: new RegExp(`^${pattern.replace(/:[a-z]+/g, "([^/]+)")}$`),
		methods,
	}));

	async function handleApi(request: Request, url: URL): Promise<Response> {
		for (const route of routes) {
			const match = route.regex.exec(url.pathname);
			if (!match) continue;
			const handler = route.methods[request.method];
			if (!handler) return json({ error: "Method not allowed" }, 405);
			try {
				return await handler(request, url, match.slice(1).map(decodeURIComponent));
			} catch (error) {
				return errorResponse(error);
			}
		}
		return json({ error: "Not found" }, 404);
	}

	async function serveStatic(url: URL): Promise<Response> {
		if (!webDir) {
			return new Response(
				"tiny-assistant daemon is running. The web app is not built: run `make build` (or `bun run web:dev`).",
				{ headers: { "content-type": "text/plain" } },
			);
		}
		const path = resolve(webDir, `.${decodeURIComponent(url.pathname)}`);
		if (path.startsWith(webDir) && existsSync(path) && statSync(path).isFile()) {
			const immutable = url.pathname.startsWith("/assets/");
			return new Response(Bun.file(path), {
				headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
			});
		}
		return new Response(Bun.file(join(webDir, "index.html")), { headers: { "cache-control": "no-cache" } });
	}

	/** The TUI as one file, so any machine with Bun can run it: `curl -o tiny.js <daemon>/tui.js && bun tiny.js <daemon>`. */
	let tuiBundle: Promise<string> | undefined;
	async function serveTuiBundle(): Promise<Response> {
		tuiBundle ??= Bun.build({
			entrypoints: [join(import.meta.dir, "../../tui/src/main.ts")],
			target: "bun",
			minify: true,
		}).then(async (result) => {
			if (!result.success || !result.outputs[0]) throw new Error(result.logs.map(String).join("\n"));
			return result.outputs[0].text();
		});
		try {
			return new Response(await tuiBundle, {
				headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
			});
		} catch (error) {
			tuiBundle = undefined;
			return errorResponse(error);
		}
	}

	function send(ws: ServerWebSocket<SocketData>, message: ServerMessage): void {
		ws.send(JSON.stringify(message));
	}

	async function onMessage(ws: ServerWebSocket<SocketData>, message: ClientMessage): Promise<void> {
		switch (message.t) {
			case "hello":
				ws.data.client = `${message.client}${message.name ? `:${message.name}` : ""}`;
				send(ws, { t: "state", state: service.state() });
				return;
			case "subscribe": {
				if (ws.data.follows.has(message.sessionId)) return;
				ws.data.follows.set(message.sessionId, () => {}); // reserve, so a duplicate subscribe is ignored
				try {
					const follow = await service.follow(message.sessionId, (update) => {
						if (update.t === "ops") send(ws, { t: "ops", sessionId: message.sessionId, ops: update.ops });
						else send(ws, { t: "ended", sessionId: message.sessionId, reason: update.reason });
					});
					if (!ws.data.follows.has(message.sessionId)) {
						follow.stop(); // unsubscribed meanwhile
						return;
					}
					ws.data.follows.set(message.sessionId, follow.stop);
					send(ws, { t: "view", sessionId: message.sessionId, value: follow.value });
				} catch (error) {
					ws.data.follows.delete(message.sessionId);
					throw error;
				}
				return;
			}
			case "unsubscribe":
				ws.data.follows.get(message.sessionId)?.();
				ws.data.follows.delete(message.sessionId);
				return;
			case "send":
				await service.send(message.sessionId, message.text, message.mode ?? "followUp", message.requestId);
				return;
			case "abort":
				await service.abort(message.sessionId);
				return;
			case "ping":
				send(ws, { t: "pong" });
				return;
		}
	}

	const server = Bun.serve<SocketData>({
		hostname: config.host,
		port: config.port,
		idleTimeout: 120,
		async fetch(request, server) {
			const url = new URL(request.url);
			const address = server.requestIP(request)?.address;
			const auth = authorize(config, request, address);
			if (!auth.ok) return json({ error: auth.reason }, auth.status);

			if (url.pathname === "/ws") {
				const upgraded = server.upgrade(request, {
					data: { follows: new Map(), client: "unknown", login: auth.login },
				});
				return upgraded ? (undefined as unknown as Response) : json({ error: "Expected a WebSocket" }, 400);
			}
			if (url.pathname.startsWith("/api/")) return handleApi(request, url);
			if (url.pathname === "/tui.js") return serveTuiBundle();
			if (config.token && url.searchParams.get("token") === config.token) {
				// Opening the web app once with ?token= remembers it in a cookie, so the phone needs no login screen.
				url.searchParams.delete("token");
				const secure = url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
				return new Response(null, {
					status: 302,
					headers: {
						location: `${url.pathname}${url.search}`,
						"set-cookie": `tiny_token=${config.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
					},
				});
			}
			return serveStatic(url);
		},
		websocket: {
			idleTimeout: 120,
			perMessageDeflate: true,
			open(ws) {
				ws.subscribe(ALL);
			},
			async message(ws, raw) {
				let message: ClientMessage;
				try {
					message = JSON.parse(String(raw)) as ClientMessage;
				} catch {
					send(ws, { t: "error", message: "Bad JSON" });
					return;
				}
				try {
					await onMessage(ws, message);
				} catch (error) {
					const sessionId = "sessionId" in message ? message.sessionId : undefined;
					send(ws, { t: "error", message: error instanceof Error ? error.message : String(error), sessionId });
				}
			},
			close(ws) {
				for (const stop of ws.data.follows.values()) stop();
				ws.data.follows.clear();
			},
		},
	});

	service.onSessionsChanged(() => {
		const message: ServerMessage = { t: "sessions", sessions: service.sessions(), projects: service.db.projects() };
		server.publish(ALL, JSON.stringify(message));
	});
	service.onRegistryChanged(() => {
		const message: ServerMessage = {
			t: "registry",
			workflows: service.workflows.list(),
			tools: service.tools(),
			models: service.modelList,
		};
		server.publish(ALL, JSON.stringify(message));
	});

	return server;
}
