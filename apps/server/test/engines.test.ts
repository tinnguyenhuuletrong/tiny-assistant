import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import {
	AGENT_DOC,
	AGENT_ENTRY_KINDS,
	AssistantClient,
	buildDisplay,
	pickEngineDefaults,
	summarizeLive,
} from "@tiny/core";
import { AgentDoc } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { ClaudeTranslator } from "../src/engines/claude-code.ts";
import {
	type AssistantMessageData,
	type Engine,
	emptyUsage,
	type TurnEvent,
	type TurnInput,
} from "../src/engines/types.ts";
import { startServer } from "../src/server.ts";
import type { AssistantService } from "../src/service.ts";
import { enableDaemonTelemetry, telemetryEnv } from "../src/telemetry.ts";
import { type Fixture, fixture, until } from "./helpers.ts";

let fx: Fixture;
let service: AssistantService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	fx?.cleanup();
});

function assistant(content: AssistantMessageData["content"]): AssistantMessageData {
	return {
		role: "assistant",
		content,
		api: "fake",
		provider: "fake",
		model: "fake-1",
		usage: emptyUsage(),
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

/** An engine that plays a script per turn and records what it was asked. */
function scripted(script: (input: TurnInput, turn: number) => AsyncIterable<TurnEvent>) {
	const calls: TurnInput[] = [];
	const engine: Engine = {
		id: "fake",
		name: "Fake",
		note: "A scripted engine",
		modelProviders: ["faux"],
		media: { inline: ["image/*"] },
		availability: () => ({ available: true }),
		run(input) {
			calls.push(input);
			return script(input, calls.length);
		},
	};
	return { engine, calls };
}

/** A turn that runs a tool, then answers. */
async function* toolTurn(input: TurnInput, turn: number): AsyncGenerator<TurnEvent> {
	yield { type: "session", id: "fake-session" };
	const call = { type: "toolCall" as const, id: `call-${turn}`, name: "Bash", arguments: { command: "echo mango" } };
	yield { type: "partial", message: assistant([{ type: "text", text: "Let me che" }]) };
	yield { type: "assistant", message: assistant([{ type: "text", text: "Let me check." }, call]) };
	yield {
		type: "toolResult",
		message: {
			role: "toolResult",
			toolCallId: call.id,
			toolName: "Bash",
			content: [{ type: "text", text: "mango" }],
			isError: false,
			timestamp: Date.now(),
		},
	};
	yield { type: "assistant", message: assistant([{ type: "text", text: `It printed mango (${input.prompt}).` }]) };
	yield {
		type: "done",
		usage: { ...emptyUsage(), input: 100, output: 20, totalTokens: 120 },
		cumulativeCost: 0.01 * turn,
	};
}

/** A turn that streams until it is stopped. */
async function* hangingTurn(input: TurnInput): AsyncGenerator<TurnEvent> {
	yield { type: "session", id: "fake-session" };
	yield { type: "partial", message: assistant([{ type: "text", text: "Working on it" }]) };
	await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
	throw new Error("aborted");
}

async function agentDoc(id: number) {
	return service!.harness.snapshot(AgentDoc, id as never, BACKGROUND);
}

describe("engine sessions", () => {
	test("a turn is recorded as entries, indexed, measured, and its engine and model are remembered", async () => {
		fx = fixture();
		const { engine, calls } = scripted(toolTurn);
		service = await fx.open({ engines: [engine] });
		expect(service.state().defaults.engine).toBe("pi");
		const project = service.createProject({ path: join(fx.root, "project") });
		const model = `${service.modelList[0]!.provider}/${service.modelList[0]!.id}`;
		const session = await service.createSession({ projectId: project.id, engine: "fake", model, text: "go" });
		expect(session.engine).toBe("fake");

		const runs = await until("the turn to be recorded", () => {
			const recorded = service!.db.runs(session.id);
			return recorded.length > 0 && recorded;
		});
		expect(runs[0]!.status).toBe("done");
		expect(runs[0]!.toolCalls).toBe(1);
		expect(runs[0]!.inputTokens).toBe(100);
		expect(calls[0]!.cwd).toBe(join(fx.root, "project"));
		expect(calls[0]!.model).toBe(service.modelList[0]!.id);
		expect(calls[0]!.resume).toBeNull();

		const { items } = await service.entries(session.id, undefined, 50);
		expect(items.map((entry) => entry.kind)).toEqual([
			AGENT_ENTRY_KINDS.user,
			AGENT_ENTRY_KINDS.assistant,
			AGENT_ENTRY_KINDS.toolResult,
			AGENT_ENTRY_KINDS.assistant,
		]);
		const doc = await agentDoc(session.id);
		expect(doc?.resume).toBe("fake-session");
		expect(doc?.run).toBeNull();
		expect(doc?.costSeen).toBe(0.01);
		const display = buildDisplay(items as never, { [AGENT_DOC]: doc as never });
		expect(display.map((item) => item.type)).toEqual(["user", "assistant", "assistant"]);
		const tool = display
			.flatMap((item) => (item.type === "assistant" ? item.parts : []))
			.find((p) => p.type === "tool");
		expect(tool?.type === "tool" && tool.tool.status === "done" && tool.tool.output).toBe("mango");

		expect(service.db.search("mango").some((hit) => hit.sessionId === session.id)).toBe(true);
		expect(service.session(session.id)?.busy).toBe(false);

		// The next new chat preselects this engine and model.
		const state = service.state();
		expect(state.defaults.engine).toBe("fake");
		expect(state.defaults.engineModels.fake).toBe(model);
		expect(pickEngineDefaults(state.engines, state.models, state.defaults).engine?.id).toBe("fake");
	});

	test("the next turn resumes the engine session, and cost is counted per turn", async () => {
		fx = fixture();
		const { engine, calls } = scripted(toolTurn);
		service = await fx.open({ engines: [engine] });
		const session = await service.createSession({ engine: "fake", text: "first" });
		await until("first turn", async () => (await agentDoc(session.id))?.costSeen === 0.01);
		await service.send(session.id, "second", "followUp", "r2");
		await until("second turn", async () => (await agentDoc(session.id))?.costSeen === 0.02);
		expect(calls[1]!.resume).toBe("fake-session");
		const doc = await agentDoc(session.id);
		const total = Object.values(doc!.usage.models).reduce(
			(sum, usage) => sum + Number((usage.cost as { total: number }).total),
			0,
		);
		expect(total).toBeCloseTo(0.02);
	});

	test("messages sent during a turn queue behind it, in order, and a resent request runs once", async () => {
		fx = fixture();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { engine, calls } = scripted(async function* (input, turn) {
			if (turn === 1) await gate;
			yield { type: "assistant", message: assistant([{ type: "text", text: `answer to ${input.prompt}` }]) };
			yield { type: "done" };
		});
		service = await fx.open({ engines: [engine] });
		const session = await service.createSession({ engine: "fake", text: "one" });
		await until("first turn to start", () => calls.length === 1);
		await service.send(session.id, "two", "steer", "r2");
		await service.send(session.id, "three", "followUp", "r3");
		await service.send(session.id, "three", "followUp", "r3");
		expect((await agentDoc(session.id))?.queue.length).toBe(2);
		expect(service.session(session.id)?.busy).toBe(true);
		release();
		await until("all turns", async () => {
			const doc = await agentDoc(session.id);
			return calls.length === 3 && doc?.run === null && doc.queue.length === 0;
		});
		expect(calls.map((call) => call.prompt)).toEqual(["one", "two", "three"]);
		const { items } = await service.entries(session.id, undefined, 50);
		const texts = items.map((entry) => {
			const message = entry.model?.[0] as { content: unknown };
			return typeof message.content === "string" ? message.content : (message.content as { text: string }[])[0]!.text;
		});
		expect(texts).toEqual(["one", "answer to one", "two", "answer to two", "three", "answer to three"]);
	});

	test("Stop kills the turn and keeps what it was writing, marked aborted", async () => {
		fx = fixture();
		const { engine } = scripted(hangingTurn);
		service = await fx.open({ engines: [engine] });
		const session = await service.createSession({ engine: "fake", text: "work" });
		await until("the partial answer", async () => (await agentDoc(session.id))?.message !== null);
		await service.abort(session.id);
		const doc = await until("the turn to end", async () => {
			const current = await agentDoc(session.id);
			return current?.run === null && current;
		});
		expect(doc.failure?.reason).toBe("aborted");
		const { items } = await service.entries(session.id, undefined, 50);
		const last = items.at(-1)?.model?.[0] as { stopReason?: string; content: { text: string }[] };
		expect(last.stopReason).toBe("aborted");
		expect(last.content[0]!.text).toBe("Working on it");
		await until("idle", () => service!.session(session.id)?.busy === false);
	});

	test("a turn the daemon died during is not run again: it ends interrupted", async () => {
		fx = fixture();
		const first = scripted(hangingTurn);
		service = await fx.open({ engines: [first.engine] });
		const session = await service.createSession({ engine: "fake", text: "work" });
		await until("the turn to start", () => first.calls.length === 1);
		await service.close();

		const second = scripted(toolTurn);
		service = await fx.open({ engines: [second.engine] });
		const doc = await until("the turn to end", async () => {
			const current = await agentDoc(session.id);
			return current?.run === null && current;
		});
		expect(doc.failure?.reason).toBe("interrupted");
		expect(second.calls.length).toBe(0);
		// The engine session is kept: the next message continues it.
		await service.send(session.id, "continue", "followUp", "r2");
		await until("the next turn", () => second.calls.length === 1);
		expect(second.calls[0]!.resume).toBe("fake-session");
	});

	test("reset forgets the engine session; workflows stay in pi sessions; unknown engines are refused", async () => {
		fx = fixture();
		const { engine, calls } = scripted(toolTurn);
		service = await fx.open({ engines: [engine] });
		const session = await service.createSession({ engine: "fake", text: "first" });
		await until("first turn", async () => (await agentDoc(session.id))?.run === null && calls.length === 1);
		await service.reset(session.id);
		await service.send(session.id, "again", "followUp", "r2");
		await until("second turn", () => calls.length === 2);
		expect(calls[1]!.resume).toBeNull();

		await expect(service.runWorkflow({ name: "nope", sessionId: session.id })).rejects.toThrow();
		await expect(service.createSession({ engine: "missing" })).rejects.toThrow('No engine "missing"');
	});

	test("clients see the turn stream into the session view", async () => {
		fx = fixture();
		const { engine } = scripted(hangingTurn);
		service = await fx.open({ engines: [engine] });
		const server = startServer(service);
		const client = new AssistantClient({ baseUrl: `http://127.0.0.1:${server.port}`, client: "tui" });
		try {
			await client.loadState();
			expect(client.engines().map((item) => item.id)).toEqual(["pi", "fake"]);
			client.connect();
			const session = await client.createSession({ engine: "fake", text: "work" });
			client.follow(session.id);
			const streaming = await until("the live answer", () => {
				const view = client.views.get(session.id);
				if (!view) return false;
				const items = buildDisplay(client.entries(session.id), view.value.docs);
				const live = items.find((item) => item.type === "assistant" && item.streaming);
				return live && summarizeLive(view.value.docs).busy && live;
			});
			expect(streaming.type === "assistant" && streaming.parts[0]).toEqual({ type: "text", text: "Working on it" });
			client.abort(session.id);
			await until("the stop to show", () => {
				const view = client.views.get(session.id);
				return view && summarizeLive(view.value.docs).failure?.reason === "aborted";
			});
		} finally {
			client.close();
			server.stop(true);
		}
	});
});

describe("engine session review fixes", () => {
	test("a zeroed cost total (an error result) does not make the next turn count the whole session", async () => {
		fx = fixture();
		const totals = [0.6, 0, 0.7];
		const { engine, calls } = scripted(async function* (input, turn) {
			yield { type: "session", id: "fake-session" };
			yield { type: "assistant", message: assistant([{ type: "text", text: input.prompt }]) };
			yield { type: "done", cumulativeCost: totals[turn - 1]!, ...(turn === 2 ? { error: "startup failed" } : {}) };
		});
		service = await fx.open({ engines: [engine] });
		const session = await service.createSession({ engine: "fake", text: "one" });
		for (const [index, text] of ["two", "three"].entries()) {
			await until("turn", async () => calls.length === index + 1 && (await agentDoc(session.id))?.run === null);
			await service.send(session.id, text, "followUp", `r${index}`);
		}
		await until("third turn", async () => calls.length === 3 && (await agentDoc(session.id))?.costSeen === 0.7);
		const doc = await agentDoc(session.id);
		const total = Object.values(doc!.usage.models).reduce(
			(sum, usage) => sum + Number((usage.cost as { total: number }).total),
			0,
		);
		expect(total).toBeCloseTo(0.7);
	});

	test("moving an engine session to another project starts a new engine session there", async () => {
		fx = fixture();
		const { engine, calls } = scripted(toolTurn);
		service = await fx.open({ engines: [engine] });
		const first = service.createProject({ path: join(fx.root, "project") });
		const session = await service.createSession({ projectId: first.id, engine: "fake", text: "one" });
		await until(
			"first turn",
			async () => (await agentDoc(session.id))?.resume === "fake-session" && (await agentDoc(session.id))?.run === null,
		);
		const other = service.createProject({ path: fx.root });
		await service.updateSession(session.id, { projectId: other.id });
		await service.send(session.id, "two", "followUp", "r2");
		await until("second turn", () => calls.length === 2);
		expect(calls[1]!.resume).toBeNull();
		expect(calls[1]!.cwd).toBe(fx.root);
	});

	test("an engine that cannot run here is not the default for new chats", async () => {
		fx = fixture();
		let available = true;
		const { engine } = scripted(toolTurn);
		service = await fx.open({ engines: [{ ...engine, availability: () => ({ available }) }] });
		await service.createSession({ engine: "fake", title: "x" });
		expect(service.state().defaults.engine).toBe("fake");
		available = false;
		expect(service.state().defaults.engine).toBe("pi");
		expect((await service.createSession({ title: "plain" })).engine).toBe("pi");
	});

	test("while a turn runs, only its own calls show as running", () => {
		const call = (id: string) => ({ type: "toolCall", id, name: "Bash", arguments: {} });
		const entries = [
			{ id: 1, conversationId: 1, kind: AGENT_ENTRY_KINDS.user, model: [{ role: "user", content: "a" }] },
			{
				id: 2,
				conversationId: 1,
				kind: AGENT_ENTRY_KINDS.assistant,
				model: [{ role: "assistant", content: [call("old")] }],
			},
			{ id: 3, conversationId: 1, kind: AGENT_ENTRY_KINDS.user, model: [{ role: "user", content: "b" }] },
			{
				id: 4,
				conversationId: 1,
				kind: AGENT_ENTRY_KINDS.assistant,
				model: [{ role: "assistant", content: [call("new")] }],
			},
		];
		const doc = {
			run: { taskId: 1, startedAt: 0, turns: 0 },
			queue: [],
			message: null,
			failure: null,
			usage: { models: {} },
		};
		const tools = buildDisplay(entries, { [AGENT_DOC]: doc as never })
			.flatMap((item) => (item.type === "assistant" ? item.parts : []))
			.flatMap((part) => (part.type === "tool" ? [[part.tool.callId, part.tool.status]] : []));
		expect(tools).toEqual([
			["old", "pending"],
			["new", "running"],
		]);
	});
});

describe("Claude Code translation", () => {
	const init = {
		type: "system",
		subtype: "init",
		session_id: "s1",
		model: "claude-opus-5-5",
		claude_code_version: "2.1.0",
		permissionMode: "bypassPermissions",
		tools: ["Bash", "Read"],
		mcp_servers: [
			{ name: "chrome", status: "connected" },
			{ name: "jira", status: "failed" },
			{ name: "notion", status: "needs-auth" },
			{ name: "docs", status: "pending" },
		],
		skills: ["pdf"],
		plugins: [],
	};

	test("blocks, tool results, and the result become turn events", () => {
		const translator = new ClaudeTranslator(true);
		const events: TurnEvent[] = [];
		const push = (message: unknown) => events.push(...translator.push(message as never));
		push(init);
		push({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1" } } });
		push({
			type: "stream_event",
			parent_tool_use_id: null,
			event: { type: "content_block_start", content_block: { type: "text", text: "" } },
		});
		push({
			type: "stream_event",
			parent_tool_use_id: null,
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
		});
		push({
			type: "assistant",
			parent_tool_use_id: null,
			message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "Hello" }] },
		});
		push({
			type: "assistant",
			parent_tool_use_id: null,
			message: {
				id: "m1",
				model: "claude-opus-5-5",
				content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
			},
		});
		// A subagent's traffic is left out.
		push({
			type: "assistant",
			parent_tool_use_id: "t9",
			message: { id: "x", content: [{ type: "text", text: "no" }] },
		});
		push({
			type: "user",
			parent_tool_use_id: null,
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
		});
		push({
			type: "assistant",
			parent_tool_use_id: null,
			message: { id: "m2", model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] },
		});
		push({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "Done.",
			total_cost_usd: 0.5,
			usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
		});

		const kinds = events.map((event) => event.type);
		expect(kinds.filter((kind) => kind !== "partial")).toEqual([
			"session",
			"notice",
			"assistant",
			"toolResult",
			"assistant",
			"done",
		]);
		const notice = events.find((event) => event.type === "notice");
		expect(notice?.type === "notice" && notice.level).toBe("warn");
		expect(notice?.type === "notice" && notice.text).toContain("MCP: chrome; failed: jira; 1 needs-auth; 1 pending");
		const first = events.find((event) => event.type === "assistant");
		expect(first?.type === "assistant" && first.message.content).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "toolCall", id: "t1", name: "Bash", arguments: { command: "ls" } },
		]);
		expect(first?.type === "assistant" && first.message.stopReason).toBe("toolUse");
		const partials = events.flatMap((event) => (event.type === "partial" ? [event.message.content] : []));
		expect(partials).toContainEqual([{ type: "text", text: "Hel" }]);
		const result = events.find((event) => event.type === "toolResult");
		expect(result?.type === "toolResult" && result.message.toolName).toBe("Bash");
		const done = events.at(-1);
		expect(done?.type === "done" && done.cumulativeCost).toBe(0.5);
		expect(done?.type === "done" && done.usage?.cacheRead).toBe(100);
		expect(done?.type === "done" && done.error).toBeUndefined();
	});

	test("an error result fails the turn with its message", () => {
		const translator = new ClaudeTranslator(false);
		const events = [
			...translator.push({ ...init, mcp_servers: [] } as never),
			...translator.push({
				type: "result",
				subtype: "success",
				is_error: true,
				result: "Not logged in · Please run /login",
				total_cost_usd: 0,
				usage: {},
			} as never),
		];
		expect(events.map((event) => event.type)).toEqual(["session", "done"]);
		const done = events.at(-1);
		expect(done?.type === "done" && done.error).toBe("Not logged in · Please run /login");
	});
});

describe("Claude Code telemetry", () => {
	test("TINY_CLAUDE_OTEL_ENDPOINT turns it on; content is opt-in", () => {
		expect(loadConfig({}).claude.otel).toBeUndefined();
		expect(loadConfig({ TINY_CLAUDE_OTEL_ENDPOINT: "http://127.0.0.1:7070/" }).claude.otel).toEqual({
			endpoint: "http://127.0.0.1:7070",
			content: false,
		});
		const config = loadConfig({ TINY_CLAUDE_OTEL_ENDPOINT: "https://otel.example", TINY_CLAUDE_OTEL_CONTENT: "1" });
		expect(config.claude.otel?.content).toBe(true);
		expect(() => loadConfig({ TINY_CLAUDE_OTEL_ENDPOINT: "127.0.0.1:7070" })).toThrow("TINY_CLAUDE_OTEL_ENDPOINT");
	});

	test("exports metrics, events, and traces as cumulative OTLP, tagged with the tiny session", () => {
		const env = telemetryEnv(
			{ endpoint: "http://127.0.0.1:7070", content: false },
			{},
			{ "tiny.session.id": "7", "tiny.project": "/work/a,b=c" },
		);
		expect(env).toEqual({
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
			OTEL_METRICS_EXPORTER: "otlp",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_TRACES_EXPORTER: "otlp",
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:7070",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
			OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "cumulative",
			OTEL_METRIC_EXPORT_INTERVAL: "1000",
			OTEL_LOGS_EXPORT_INTERVAL: "1000",
			OTEL_TRACES_EXPORT_INTERVAL: "1000",
			OTEL_RESOURCE_ATTRIBUTES: "tiny.session.id=7,tiny.project=%2Fwork%2Fa%2Cb%3Dc",
		});
		expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
	});

	test("content opt-in, and the daemon's own OTEL_* settings win", () => {
		const env = telemetryEnv(
			{ endpoint: "http://127.0.0.1:7070", content: true },
			{ OTEL_TRACES_EXPORTER: "none", OTEL_RESOURCE_ATTRIBUTES: "enduser.id=me" },
			{ "tiny.session.id": "7", "tiny.project": undefined },
		);
		expect(env.OTEL_TRACES_EXPORTER).toBeUndefined();
		expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe("enduser.id=me,tiny.session.id=7");
		expect(env.OTEL_LOG_USER_PROMPTS).toBe("1");
		expect(env.OTEL_LOG_TOOL_DETAILS).toBe("1");
		expect(env.OTEL_LOG_TOOL_CONTENT).toBe("1");
	});

	test("the daemon's own environment covers Tiny chats' claude-code provider; a turn's tags replace its own", () => {
		const daemon: Record<string, string | undefined> = { OTEL_RESOURCE_ATTRIBUTES: "enduser.id=me" };
		enableDaemonTelemetry(undefined, daemon);
		expect(daemon.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
		enableDaemonTelemetry({ endpoint: "http://127.0.0.1:7070", content: false }, daemon);
		expect(daemon.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
		expect(daemon.OTEL_RESOURCE_ATTRIBUTES).toBe("enduser.id=me,tiny.engine=pi");
		const turn = telemetryEnv({ endpoint: "http://127.0.0.1:7070", content: false }, daemon, {
			"tiny.engine": "claude-code",
			"tiny.session.id": "7",
		});
		expect(turn.OTEL_RESOURCE_ATTRIBUTES).toBe("enduser.id=me,tiny.engine=claude-code,tiny.session.id=7");
		expect(turn.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
	});
});
