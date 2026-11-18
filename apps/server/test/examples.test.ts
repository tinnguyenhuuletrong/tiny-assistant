import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AssistantService } from "../src/service.ts";
import { type Fixture, fixture, until } from "./helpers.ts";

// The bundled example workflows, run for real: they import @tiny/core, so they are copied into a folder inside the
// workspace (where the package resolves) rather than the temp dir.
const assistantDir = join(import.meta.dir, `.assistant-${process.pid}`);
let fx: Fixture;
let service: AssistantService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	fx?.cleanup();
	rmSync(assistantDir, { recursive: true, force: true });
});

function useExample(name: string) {
	mkdirSync(join(assistantDir, "workflows"), { recursive: true });
	cpSync(
		join(import.meta.dir, "../../../assistant/workflows", `${name}.ts`),
		join(assistantDir, "workflows", `${name}.ts`),
	);
	fx.config.assistantDir = assistantDir;
}

const git = (cwd: string, ...args: string[]) => {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return result.stdout.toString().trim();
};

async function finished(sessionId: number) {
	return until(
		"the workflow to finish",
		async () => {
			const { items } = await service!.entries(sessionId, undefined, 200);
			return items.find((entry) => entry.kind === "tiny.workflow.finished");
		},
		20_000,
	);
}

describe("safe-change", () => {
	function repo(): string {
		const dir = join(fx.root, "project");
		git(dir, "init", "-q", "-b", "main");
		// The workflow commits; don't depend on the machine having a git identity (CI runners have none).
		git(dir, "config", "user.name", "tiny test");
		git(dir, "config", "user.email", "test@example.com");
		writeFileSync(join(dir, "notes.md"), "# notes\n");
		git(dir, "add", "-A");
		git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
		return dir;
	}

	test("failed tests roll back to a clean tree, removing files the attempt created", async () => {
		fx = fixture();
		useExample("safe-change");
		const dir = repo();
		fx.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo new > added.txt && echo edit >> notes.md" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done."),
		]);
		service = await fx.open();
		const project = service.createProject({ path: dir });
		const { sessionId } = await service.runWorkflow({
			name: "safe-change",
			projectId: project.id,
			input: { task: "change things", test: "exit 1" },
		});
		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "failed", rolledBack: ["create branch"] });
		expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(git(dir, "status", "--porcelain")).toBe(""); // no leftover added.txt, notes.md restored
		expect(existsSync(join(dir, "added.txt"))).toBe(false);
		expect(git(dir, "branch", "--list", "tiny/*")).toBe("");
	});

	test("the task text is never run by the shell", async () => {
		fx = fixture();
		useExample("safe-change");
		const dir = repo();
		fx.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo v1 >> notes.md" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		service = await fx.open();
		const project = service.createProject({ path: dir });
		const task = "Add a `--version` flag $(touch PWNED) 'quoted'";
		const { sessionId } = await service.runWorkflow({
			name: "safe-change",
			projectId: project.id,
			input: { task, test: "true" },
		});
		const done = await finished(sessionId);
		expect(done.data).toMatchObject({ status: "completed" });
		expect(existsSync(join(dir, "PWNED"))).toBe(false);
		expect(git(dir, "log", "-1", "--format=%s", "tiny/run-" + (done.data as { runId: number }).runId)).toBe(
			`tiny: ${task}`.slice(0, 72),
		);
	});

	test("refuses to start on uncommitted work", async () => {
		fx = fixture();
		useExample("safe-change");
		const dir = repo();
		writeFileSync(join(dir, "notes.md"), "uncommitted\n");
		service = await fx.open();
		const project = service.createProject({ path: dir });
		const { sessionId } = await service.runWorkflow({
			name: "safe-change",
			projectId: project.id,
			input: { task: "x" },
		});
		const done = await finished(sessionId);
		expect((done.data as { error: string }).error).toContain("uncommitted changes");
		expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("uncommitted\n");
	});
});
