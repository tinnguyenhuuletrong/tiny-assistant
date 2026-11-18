import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantClient, buildDisplay, summarizeLive } from "@tiny/core";
import { startServer } from "../src/server.ts";
import type { AssistantService } from "../src/service.ts";
import { type Fixture, fixture, until } from "./helpers.ts";

let fx: Fixture;
let service: AssistantService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	fx?.cleanup();
});

describe("sessions", () => {
	test("a run with a tool call is answered, indexed for search, and measured", async () => {
		fx = fixture();
		fx.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo pineapple" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The command printed pineapple."),
		]);
		service = await fx.open();
		const project = service.createProject({ path: join(fx.root, "project") });
		const session = await service.createSession({ projectId: project.id, text: "Run echo pineapple" });
		expect(session.cwd).toBe(join(fx.root, "project"));

		const runs = await until("the run to be recorded", () => {
			const recorded = service!.db.runs(session.id);
			return recorded.length > 0 && recorded;
		});
		expect(runs[0]!.toolCalls).toBe(1);
		expect(runs[0]!.status).toBe("done");

		const { items } = await service.entries(session.id, undefined, 50);
		const tool = items.find((entry) => entry.kind === "pi.tool-result");
		expect(JSON.stringify(tool?.model)).toContain("pineapple");

		const hits = service.db.search("pineapple");
		expect(hits.some((hit) => hit.sessionId === session.id && hit.role === "assistant")).toBe(true);
		expect(service.session(session.id)?.busy).toBe(false);
		expect(service.session(session.id)?.preview).toContain("pineapple");
	});

	test("model and project changes are stored on the session and its agent", async () => {
		fx = fixture();
		service = await fx.open();
		const session = await service.createSession({ title: "Plain" });
		const project = service.createProject({ path: join(fx.root, "project") });
		const updated = await service.updateSession(session.id, { projectId: project.id, thinking: "high", pinned: true });
		expect(updated.projectId).toBe(project.id);
		expect(updated.thinking).toBe("high");
		expect(updated.pinned).toBe(true);
		const agent = await (await service.harness.conversation(session.id as never, BACKGROUND))!.agent(BACKGROUND);
		expect(agent.cwd).toBe(join(fx.root, "project"));
	});
});

describe("workflows", () => {
	test("finished steps are not run again after the daemon restarts mid-run", async () => {
		fx = fixture();
		const log = join(fx.root, "steps.log");
		const marker = join(fx.root, "first-attempt");
		// Plain object form, so the fixture needs no package resolution.
		writeFileSync(
			join(fx.config.assistantDir, "workflows", "resume.ts"),
			`import { appendFileSync, existsSync, writeFileSync } from "node:fs";
export default {
	kind: "tiny.workflow",
	name: "resume",
	description: "test",
	async run(ctx) {
		await ctx.step("one", () => { appendFileSync(${JSON.stringify(log)}, "one\\n"); return 1; });
		await ctx.step("two", async () => {
			appendFileSync(${JSON.stringify(log)}, "two\\n");
			if (!existsSync(${JSON.stringify(marker)})) {
				writeFileSync(${JSON.stringify(marker)}, "x");
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, 60_000);
					ctx.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
				});
			}
			return 2;
		});
		return "finished";
	},
};
`,
		);
		service = await fx.open();
		const { sessionId } = await service.runWorkflow({ name: "resume" });
		await until(
			"step two to start",
			async () => (await Bun.file(log).exists()) && (await Bun.file(log).text()).includes("two"),
		);

		await service.close(); // the "crash": step two is interrupted
		service = await fx.open(); // resumes the pending task

		const finished = await until("the workflow to finish", async () => {
			const { items } = await service!.entries(sessionId, undefined, 100);
			return items.find((entry) => entry.kind === "tiny.workflow.finished");
		});
		expect((finished.data as { status: string; result: unknown }).status).toBe("completed");
		expect((finished.data as { result: unknown }).result).toBe("finished");
		const lines = (await Bun.file(log).text()).trim().split("\n");
		expect(lines.filter((line) => line === "one")).toHaveLength(1); // memoized, never rerun
		expect(lines.filter((line) => line === "two")).toHaveLength(2); // interrupted, so run again
	});

	test("invalid workflow input is rejected before a run starts", async () => {
		fx = fixture();
		writeFileSync(
			join(fx.config.assistantDir, "workflows", "typed.ts"),
			`export default { kind: "tiny.workflow", name: "typed", description: "t",
				input: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
				async run(ctx) { return ctx.input.n * 2; } };`,
		);
		service = await fx.open();
		await expect(service.runWorkflow({ name: "typed", input: {} })).rejects.toThrow(/Invalid input/);
		expect(service.sessions()).toHaveLength(0);
	});
});

describe("sync", () => {
	test("two clients following one session see the same streamed answer", async () => {
		fx = fixture();
		fx.faux.setResponses([fauxAssistantMessage("Hello from **tiny**.")]);
		service = await fx.open();
		const server = startServer(service);
		const base = `http://127.0.0.1:${server.port}`;
		const web = new AssistantClient({ baseUrl: base, client: "web" });
		const tui = new AssistantClient({ baseUrl: base, client: "tui" });
		try {
			for (const client of [web, tui]) {
				client.connect();
				await client.loadState();
			}
			const session = await web.createSession({ title: "sync test" });
			await until("the TUI to see the new session", () => tui.state?.sessions.some((s) => s.id === session.id));
			web.follow(session.id);
			tui.follow(session.id);
			await until("both views", () => web.views.has(session.id) && tui.views.has(session.id));

			tui.send(session.id, "Say hello");

			const answer = (client: AssistantClient) => {
				const view = client.views.get(session.id);
				if (!view || summarizeLive(view.value.docs).busy) return undefined;
				const items = buildDisplay(client.entries(session.id), view.value.docs);
				const last = items.at(-1);
				return last?.type === "assistant" && last.parts[0]?.type === "text" ? last.parts[0].text : undefined;
			};
			expect(await until("web answer", () => answer(web))).toBe("Hello from **tiny**.");
			expect(await until("tui answer", () => answer(tui))).toBe("Hello from **tiny**.");
			expect(web.entries(session.id).map((e) => e.id)).toEqual(tui.entries(session.id).map((e) => e.id));
		} finally {
			web.close();
			tui.close();
			server.stop(true);
		}
	});
});
