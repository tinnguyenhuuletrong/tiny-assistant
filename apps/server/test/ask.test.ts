import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantClient } from "@tiny/core";
import { startServer } from "../src/server.ts";
import { type AssistantService, HttpError } from "../src/service.ts";
import { type Fixture, fixture, until } from "./helpers.ts";

let fx: Fixture;
let service: AssistantService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	fx?.cleanup();
});

/** An approval workflow in plain-object form; `log` records what actually ran. */
function writeApproval(options: string): string {
	const log = join(fx.root, "approval.log");
	writeFileSync(
		join(fx.config.assistantDir, "workflows", "approval.ts"),
		`import { appendFileSync } from "node:fs";
const log = (line) => appendFileSync(${JSON.stringify(log)}, line + "\\n");
export default {
	kind: "tiny.workflow",
	name: "approval",
	description: "test",
	async run(ctx) {
		await ctx.step("reserve", () => { log("reserve"); return 1; }, { undo: () => log("release") });
		const answer = await ctx.ask("Approve the expense?", ${options});
		if (answer !== "Approve") throw new Error("Rejected");
		await ctx.step("pay", () => { log("pay"); return 2; });
		return "paid";
	},
};
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

async function asked(sessionId: number) {
	return until("the question", async () => {
		const { items } = await service!.entries(sessionId, undefined, 200);
		const ask = items.find((entry) => entry.kind === "tiny.workflow.ask");
		return ask && service!.session(sessionId)?.waitingForInput
			? (ask.data as { runId: number; key: string; choices?: string[] })
			: undefined;
	});
}

async function status(promise: Promise<unknown>): Promise<number | "ok"> {
	try {
		await promise;
		return "ok";
	} catch (error) {
		if (error instanceof HttpError) return error.status;
		throw error;
	}
}

describe("human in the loop", () => {
	test("a run waits for the answer, then continues with it", async () => {
		fx = fixture();
		const log = writeApproval(`{ choices: ["Approve", "Reject"] }`);
		service = await fx.open();
		const { sessionId } = await service.runWorkflow({ name: "approval" });
		const ask = await asked(sessionId);
		expect(ask.choices).toEqual(["Approve", "Reject"]);
		expect(service.session(sessionId)?.workflowRunning).toBe(true);

		expect(await status(service.answerWorkflow({ sessionId, runId: ask.runId, key: ask.key, value: "Maybe" }))).toBe(
			400,
		);
		expect(await status(service.answerWorkflow({ sessionId, runId: ask.runId, key: ask.key, value: "Approve" }))).toBe(
			"ok",
		);
		expect(await status(service.answerWorkflow({ sessionId, runId: ask.runId, key: ask.key, value: "Approve" }))).toBe(
			409,
		);

		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "completed", result: "paid" });
		expect(await lines(log)).toEqual(["reserve", "pay"]); // reserve ran once, before and after the wait
		expect(service.session(sessionId)?.waitingForInput).toBe(false);
	});

	test("the question survives a restart", async () => {
		fx = fixture();
		const log = writeApproval(`{ choices: ["Approve", "Reject"] }`);
		service = await fx.open();
		const { sessionId } = await service.runWorkflow({ name: "approval" });
		const ask = await asked(sessionId);
		await service.close();

		service = await fx.open();
		expect(service.session(sessionId)?.waitingForInput).toBe(true); // re-registered at startup
		await service.answerWorkflow({ sessionId, runId: ask.runId, key: ask.key, value: "Approve" });
		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "completed", result: "paid" });
		expect(await lines(log)).toEqual(["reserve", "pay"]);
	});

	test("a rejection fails the run and rolls back", async () => {
		fx = fixture();
		const log = writeApproval(`{ choices: ["Approve", "Reject"] }`);
		service = await fx.open();
		const { sessionId } = await service.runWorkflow({ name: "approval" });
		const ask = await asked(sessionId);
		await service.answerWorkflow({ sessionId, runId: ask.runId, key: ask.key, value: "Reject" });
		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "failed", error: "Rejected", rolledBack: ["reserve"] });
		expect(await lines(log)).toEqual(["reserve", "release"]);
	});

	test("Stop while waiting rolls back", async () => {
		fx = fixture();
		const log = writeApproval(`{ choices: ["Approve", "Reject"] }`);
		service = await fx.open();
		const { sessionId } = await service.runWorkflow({ name: "approval" });
		await asked(sessionId);
		await service.abort(sessionId);
		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "aborted", rolledBack: ["reserve"] });
		expect(await lines(log)).toEqual(["reserve", "release"]);
		await until("the waiting flag to clear", () => service!.session(sessionId)?.waitingForInput === false);
	});

	test("no answer in time fails the run and rolls back", async () => {
		fx = fixture();
		const log = writeApproval(`{ choices: ["Approve", "Reject"], timeoutMs: 300 }`);
		service = await fx.open();
		const { sessionId } = await service.runWorkflow({ name: "approval" });
		const ask = await asked(sessionId);
		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "failed", rolledBack: ["reserve"] });
		expect((done.data as { error: string }).error).toContain("No answer");
		expect(await lines(log)).toEqual(["reserve", "release"]);
		expect(await status(service.answerWorkflow({ sessionId, runId: ask.runId, key: ask.key, value: "Approve" }))).toBe(
			409,
		);
	});

	test("clients answer over HTTP", async () => {
		fx = fixture();
		writeApproval(`{ choices: ["Approve", "Reject"] }`);
		service = await fx.open();
		const server = startServer(service);
		const client = new AssistantClient({ baseUrl: `http://127.0.0.1:${server.port}`, client: "web" });
		try {
			const { sessionId } = await client.runWorkflow({ name: "approval" });
			const ask = await asked(sessionId);
			await expect(client.answerWorkflow({ sessionId, runId: ask.runId, key: ask.key, value: "Nope" })).rejects.toThrow(
				/one of/,
			);
			await client.answerWorkflow({ sessionId, runId: ask.runId, key: ask.key, value: "Approve" });
			expect((await finished(sessionId)).data).toMatchObject({ status: "completed", result: "paid" });
		} finally {
			server.stop(true);
		}
	});
});
