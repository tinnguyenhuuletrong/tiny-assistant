import { describe, expect, test } from "bun:test";
import { buildDisplay, summarizeLive, toolSummary } from "./display.ts";
import type { ViewEntry } from "./protocol.ts";

const user = (id: number, text: string): ViewEntry => ({
	id,
	conversationId: 1,
	kind: "pi.user",
	model: [{ role: "user", content: text, timestamp: 1 }],
});

describe("buildDisplay", () => {
	test("attaches tool results to their calls and hides system entries", () => {
		const entries: ViewEntry[] = [
			{ id: 1, conversationId: 1, kind: "pi.system", model: [] },
			user(2, "list files"),
			{
				id: 3,
				conversationId: 1,
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						model: "m",
						content: [
							{ type: "thinking", thinking: "let me look" },
							{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
						],
						usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				],
			},
			{
				id: 4,
				conversationId: 1,
				kind: "pi.tool-result",
				model: [{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a\nb" }] }],
			},
			{
				id: 5,
				conversationId: 1,
				kind: "pi.assistant",
				model: [{ role: "assistant", content: [{ type: "text", text: "Two files." }] }],
			},
		];
		const items = buildDisplay(entries, {});
		expect(items.map((item) => item.type)).toEqual(["user", "assistant", "assistant"]);
		const call = items[1]!;
		if (call.type !== "assistant") throw new Error("expected assistant");
		expect(call.parts[0]).toEqual({ type: "thinking", text: "let me look", redacted: false });
		const tool = call.parts[1];
		if (tool?.type !== "tool") throw new Error("expected tool");
		expect(tool.tool.status).toBe("done");
		expect(tool.tool.output).toBe("a\nb");
		expect(toolSummary(tool.tool)).toBe("ls");
		expect(call.usage?.cost).toBe(0.01);
	});

	test("shows the streamed partial answer and running tool output from pi.live", () => {
		const entries: ViewEntry[] = [
			user(1, "go"),
			{
				id: 2,
				conversationId: 1,
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } }],
					},
				],
			},
		];
		const docs = {
			"pi.live": {
				run: { taskId: 9, inputs: [1], turns: 1 },
				tools: [{ callId: "c1", name: "bash", status: "running", output: "compiling…" }],
				generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "Partial" }] } },
			},
			"pi.inbox": { items: [{}, {}] },
		};
		const items = buildDisplay(entries, docs);
		const running = items[1];
		if (running?.type !== "assistant" || running.parts[0]?.type !== "tool") throw new Error("expected tool");
		expect(running.parts[0].tool.status).toBe("running");
		expect(running.parts[0].tool.output).toBe("compiling…");
		const live = items[2];
		expect(live?.type === "assistant" && live.streaming).toBe(true);
		expect(summarizeLive(docs)).toMatchObject({ busy: true, generating: true, queued: 2, turns: 1 });
	});

	test("reports why the last run failed once it is over", () => {
		const items = buildDisplay([user(1, "hi")], {
			"pi.live": { runFailure: { reason: "model_error", detail: "429" } },
		});
		expect(items.at(-1)).toMatchObject({ type: "notice", level: "error", text: "Model error: 429" });
	});
});
