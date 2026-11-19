/** End-to-end smoke test against a running daemon: `bun scripts/smoke.ts http://127.0.0.1:7777 [model]` */
import { AssistantClient, buildDisplay, summarizeLive } from "@tiny/core";

const base = process.argv[2] ?? "http://127.0.0.1:7777";
const model = process.argv[3] ?? "claude-code/claude-haiku-5-5";
const client = new AssistantClient({ baseUrl: base, client: "tui", name: "smoke" });
client.onError((message) => console.error("server error:", message));
client.connect();
await client.loadState();
const project = await client.createProject({ path: process.cwd() });
const session = await client.createSession({
	projectId: project.id,
	// Tiny's own loop, whatever new chats default to: the prompt uses tiny's `now` tool.
	engine: "pi",
	model,
	text: "Use the `now` tool to get the time in Asia/Ho_Chi_Minh, then run `ls` with bash and tell me how many entries there are. Answer in one short markdown list.",
});
console.log("session", session.id, session.title);
client.follow(session.id);
let sawBusy = false;
let opsSeen = 0;
client.subscribe(() => {
	const view = client.views.get(session.id);
	if (!view) return;
	opsSeen++;
	const live = summarizeLive(view.value.docs);
	if (live.busy) sawBusy = true;
});
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
	await Bun.sleep(500);
	const view = client.views.get(session.id);
	if (view && sawBusy && !summarizeLive(view.value.docs).busy) break;
}
const view = client.views.get(session.id)!;
for (const item of buildDisplay(client.entries(session.id), view.value.docs)) {
	if (item.type === "user") console.log(`USER: ${item.text}`);
	else if (item.type === "assistant") {
		for (const part of item.parts) {
			if (part.type === "text") console.log(`ASSISTANT: ${part.text}`);
			else if (part.type === "thinking") console.log(`THINKING: ${part.text.slice(0, 80)}…`);
			else
				console.log(
					`TOOL ${part.tool.name} [${part.tool.status}] ${JSON.stringify(part.tool.args)} -> ${part.tool.output.slice(0, 120).replace(/\n/g, " | ")}`,
				);
		}
	} else console.log(item.type, JSON.stringify(item).slice(0, 200));
}
console.log("updates received:", opsSeen, "sessions:", client.state?.sessions.length);
console.log("stats:", JSON.stringify(await client.stats(session.id)));
console.log("search 'Ho_Chi_Minh':", JSON.stringify(await client.search("Ho_Chi_Minh")).slice(0, 300));
client.close();
process.exit(0);
