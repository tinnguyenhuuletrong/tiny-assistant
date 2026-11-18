import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantService } from "../src/service.ts";
import { type Fixture, fixture, until } from "./helpers.ts";

let fx: Fixture;
let service: AssistantService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	fx?.cleanup();
});

/** A saga in plain-object form (no package imports needed in the temp assistant dir). */
function writeSaga(name: string, body: string): string {
	const log = join(fx.root, `${name}.log`);
	writeFileSync(
		join(fx.config.assistantDir, "workflows", `${name}.ts`),
		`import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const log = (line) => appendFileSync(${JSON.stringify(log)}, line + "\\n");
const marker = (name) => ${JSON.stringify(fx.root)} + "/" + name;
const waitForAbort = (signal) => new Promise((_, reject) => {
	const timer = setTimeout(() => reject(new Error("not aborted")), 30_000);
	signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
});
export default { kind: "tiny.workflow", name: ${JSON.stringify(name)}, description: "test", async run(ctx) { ${body} } };
`,
	);
	return log;
}

const lines = async (path: string) =>
	(await Bun.file(path).exists()) ? (await Bun.file(path).text()).trim().split("\n") : [];

async function finished(sessionId: number) {
	return until("the workflow to finish", async () => {
		const { items } = await service!.entries(sessionId, undefined, 200);
		return items.find((entry) => entry.kind === "tiny.workflow.finished");
	});
}

describe("workflow rollback", () => {
	test("a failure undoes the finished steps, newest first", async () => {
		fx = fixture();
		const log = writeSaga(
			"saga",
			`await ctx.step("a", () => { log("do a"); return "A"; }, { undo: (v) => log("undo a " + v) });
			await ctx.step("no-undo", () => 1);
			await ctx.step("b", () => { log("do b"); return "B"; }, { undo: (v) => log("undo b " + v) });
			await ctx.step("c", () => { throw new Error("card declined"); }, { undo: () => log("undo c") });`,
		);
		service = await fx.open();
		const { sessionId } = await service.runWorkflow({ name: "saga" });
		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "failed", rolledBack: ["b", "a"] });
		expect((done.data as { error: string }).error).toContain("card declined");
		expect(await lines(log)).toEqual(["do a", "do b", "undo b B", "undo a A"]); // c never finished: no undo

		const { items } = await service.entries(sessionId, undefined, 200);
		const statuses = items
			.filter((entry) => entry.kind === "tiny.workflow.step")
			.map((entry) => `${(entry.data as { step: string }).step}:${(entry.data as { status: string }).status}`);
		expect(statuses).toEqual([
			"a:running",
			"a:done",
			"no-undo:running",
			"no-undo:done",
			"b:running",
			"b:done",
			"c:running",
			"c:failed",
			"b:undoing",
			"b:undone",
			"a:undoing",
			"a:undone",
		]);
		expect(items.some((entry) => entry.kind === "tiny.workflow.rollback")).toBe(true);
	});

	test("Stop undoes the finished steps too", async () => {
		fx = fixture();
		const log = writeSaga(
			"stoppable",
			`await ctx.step("reserve", () => { log("reserve"); return 1; }, { undo: () => log("release") });
			await ctx.step("wait", () => waitForAbort(ctx.signal));`,
		);
		service = await fx.open();
		const { sessionId } = await service.runWorkflow({ name: "stoppable" });
		await until("the run to reach its second step", async () => (await lines(log)).includes("reserve"));
		await Bun.sleep(100);
		await service.abort(sessionId);
		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "aborted", rolledBack: ["reserve"] });
		expect(await lines(log)).toEqual(["reserve", "release"]);
	});

	test("Stop during a step still undoes it once it took effect", async () => {
		fx = fixture();
		const log = writeSaga(
			"inflight",
			`await ctx.step("reserve", () => { log("reserve"); return 1; }, { undo: () => log("release") });
			await ctx.step("charge", async () => {
				log("charge start");
				await new Promise((resolve) => setTimeout(resolve, 400)); // ignores Stop, like a slow payment API
				log("charged");
				return "receipt-1";
			}, { undo: (receipt) => log("refund " + receipt) });
			await ctx.step("never", () => 1);`,
		);
		service = await fx.open();
		const { sessionId } = await service.runWorkflow({ name: "inflight" });
		await until("the charge to start", async () => (await lines(log)).includes("charge start"));
		await service.abort(sessionId);
		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "aborted", rolledBack: ["charge", "reserve"] });
		expect(await lines(log)).toEqual(["reserve", "charge start", "charged", "refund receipt-1", "release"]);
	});

	test("a crash during the rollback resumes it without undoing anything twice", async () => {
		fx = fixture();
		const log = writeSaga(
			"crashy",
			`await ctx.step("a", () => "A", { undo: async () => {
				log("undo a");
				if (!existsSync(marker("a-once"))) { writeFileSync(marker("a-once"), "x"); await waitForAbort(ctx.signal); }
			} });
			await ctx.step("b", () => "B", { undo: () => log("undo b") });
			await ctx.step("c", () => { throw new Error("boom"); });`,
		);
		service = await fx.open();
		const { sessionId } = await service.runWorkflow({ name: "crashy" });
		// b is undone first (newest first), then undoing a hangs: crash there.
		await until("undo a to start", async () => (await lines(log)).includes("undo a"));
		await service.close();
		service = await fx.open();
		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "failed", rolledBack: ["b", "a"] });
		// b's undo was checkpointed before the crash, so it is not repeated; a's never finished, so it runs again.
		expect(await lines(log)).toEqual(["undo b", "undo a", "undo a"]);
	});
});

describe("exec steps", () => {
	test("check: true fails the step itself, and a shell undo reverts it", async () => {
		fx = fixture();
		const file = join(fx.root, "project", "made-by-step");
		writeSaga(
			"shell",
			`await ctx.exec("touch made-by-step", { step: "make file", undo: "rm made-by-step", cwd: ${JSON.stringify(join(fx.root, "project"))} });
			await ctx.exec("echo broken; exit 3", { step: "tests", check: true });`,
		);
		service = await fx.open();
		const { sessionId } = await service.runWorkflow({ name: "shell" });
		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "failed", rolledBack: ["make file"] });
		expect((done.data as { error: string }).error).toContain("exited 3: broken");
		expect(await Bun.file(file).exists()).toBe(false);
		const { items } = await service.entries(sessionId, undefined, 200);
		const tests = items.filter((e) => e.kind === "tiny.workflow.step" && (e.data as { step: string }).step === "tests");
		expect(tests.map((e) => (e.data as { status: string }).status)).toEqual(["running", "failed"]);
	});
});
