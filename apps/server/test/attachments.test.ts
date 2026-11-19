import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { AssistantClient, buildDisplay, USER_ENTRY_KIND } from "@tiny/core";
import { AgentDoc } from "../src/agent.ts";
import type { Engine, TurnInput } from "../src/engines/types.ts";
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

/** A 1×1 PNG. */
const PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
	(char) => char.charCodeAt(0),
);
const PDF = new TextEncoder().encode("%PDF-1.4\n%fake\n");

function files() {
	return [
		new File([PNG], "dot.png", { type: "image/png" }),
		new File(["a,b\n1,2\n"], "data.csv", { type: "text/csv" }),
		new File([PDF], "spec.pdf", { type: "application/pdf" }),
		new File(["<script>alert(1)</script>"], "page.html", { type: "text/html" }),
	];
}

function textOf(content: unknown): string {
	return Array.isArray(content)
		? content.map((part) => (part as { text?: string }).text ?? "").join("")
		: String(content);
}

describe("attachments", () => {
	test("uploads are served safely: plain images inline, anything else as a sandboxed download", async () => {
		fx = fixture();
		service = await fx.open();
		const server = startServer(service);
		const client = new AssistantClient({ baseUrl: `http://127.0.0.1:${server.port}`, client: "tui" });
		try {
			const uploaded = await client.upload(files());
			expect(uploaded.map((file) => [file.name, file.mimeType])).toEqual([
				["dot.png", "image/png"],
				["data.csv", "text/csv"],
				["spec.pdf", "application/pdf"],
				["page.html", "text/html"],
			]);
			const image = await fetch(client.uploadUrl(uploaded[0]!.id));
			expect(image.headers.get("content-type")).toBe("image/png");
			expect(image.headers.get("content-disposition")).toStartWith("inline");
			expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
			const html = await fetch(client.uploadUrl(uploaded[3]!.id));
			expect(html.headers.get("content-type")).toBe("application/octet-stream");
			expect(html.headers.get("content-disposition")).toStartWith("attachment");
			expect(html.headers.get("content-security-policy")).toContain("sandbox");
			expect((await fetch(client.uploadUrl("nope"))).status).toBe(404);

			const big = new File([new Uint8Array(6 * 1024 * 1024)], "big.bin");
			await expect(client.upload([big])).rejects.toThrow("limit");
		} finally {
			server.stop(true);
		}
	});

	test("a Tiny chat gets images as content, small text files in the message, and every file's path", async () => {
		fx = fixture();
		fx.faux.setResponses([fauxAssistantMessage("Got them.")]);
		service = await fx.open();
		const uploaded = await service.upload(files());
		const session = await service.createSession({
			text: "Look at these",
			attachments: uploaded.map((file) => file.id),
		});
		await until("the answer", () => service!.db.runs(session.id).length > 0);

		const { items } = await service.entries(session.id, undefined, 50);
		const user = items.find((entry) => entry.kind === USER_ENTRY_KIND)!;
		expect(user.data).toEqual({ text: "Look at these", attachments: uploaded });
		const content = (user.model![0] as { content: { type: string; mimeType?: string }[] }).content;
		expect(content.filter((part) => part.type === "image").map((part) => part.mimeType)).toEqual(["image/png"]);
		const text = textOf(content);
		expect(text).toStartWith("Look at these\n\n<attachments>");
		for (const name of ["dot.png", "data.csv", "spec.pdf", "page.html"]) expect(text).toContain(name);
		expect(text).toContain('<file name="data.csv">\na,b\n1,2\n</file>');
		expect(text).toContain("(attached as an image)");
		// The PDF is not something pi models take: it is a path.
		expect(text).not.toContain("attached as a document");

		const display = buildDisplay(items as never, {});
		const shown = display.find((item) => item.type === "user");
		expect(shown?.type === "user" && shown.text).toBe("Look at these");
		expect(shown?.type === "user" && shown.attachments.map((file) => file.name)).toEqual(
			uploaded.map((file) => file.name),
		);
	});

	test("an engine gets the files it takes natively as content, and a message may be files alone", async () => {
		fx = fixture();
		const calls: TurnInput[] = [];
		const engine: Engine = {
			id: "fake",
			name: "Fake",
			note: "",
			modelProviders: ["faux"],
			media: { inline: ["image/*", "application/pdf"] },
			availability: () => ({ available: true }),
			async *run(input) {
				calls.push(input);
				yield { type: "done" };
			},
		};
		service = await fx.open({ engines: [engine] });
		expect(service.state().engines.find((item) => item.id === "fake")?.media).toEqual({
			inline: ["image/*", "application/pdf"],
			maxFileBytes: 5 * 1024 * 1024,
		});
		const uploaded = await service.upload(files());
		const session = await service.createSession({ engine: "fake", attachments: uploaded.map((file) => file.id) });
		await until(
			"the turn",
			async () =>
				calls.length === 1 &&
				(await service!.harness.snapshot(AgentDoc, session.id as never, BACKGROUND))?.run === null,
		);

		const [input] = calls;
		expect(input!.prompt).toBe("");
		const byName = Object.fromEntries(input!.attachments.map((file) => [file.name, file]));
		expect(byName["dot.png"]?.inline?.mimeType).toBe("image/png");
		expect(byName["spec.pdf"]?.inline?.mimeType).toBe("application/pdf");
		expect(Buffer.from(byName["spec.pdf"]!.inline!.data, "base64").toString()).toBe("%PDF-1.4\n%fake\n");
		expect(byName["data.csv"]?.text).toBe("a,b\n1,2\n");
		expect(byName["page.html"]?.inline).toBeUndefined();
		expect(service.session(session.id)?.title).toBe("📎 dot.png");

		await expect(service.send(session.id, "", "followUp", "r2")).rejects.toThrow("Empty message");
		await expect(service.send(session.id, "hi", "followUp", "r3", ["missing"])).rejects.toThrow("No upload missing");
	});

	test("a model without image input gets images as paths", async () => {
		fx = fixture();
		fx.faux.setResponses([fauxAssistantMessage("ok")]);
		service = await fx.open();
		service.modelList = service.modelList.map((model) => ({ ...model, input: ["text"] }));
		const [image] = await service.upload([new File([PNG], "dot.png", { type: "image/png" })]);
		const session = await service.createSession({ text: "see", attachments: [image!.id] });
		await until("the answer", () => service!.db.runs(session.id).length > 0);
		const { items } = await service.entries(session.id, undefined, 50);
		const content = (
			items.find((entry) => entry.kind === USER_ENTRY_KIND)!.model![0] as { content: { type: string }[] }
		).content;
		expect(content.some((part) => part.type === "image")).toBe(false);
		expect(textOf(content)).toContain("dot.png");
	});
});
