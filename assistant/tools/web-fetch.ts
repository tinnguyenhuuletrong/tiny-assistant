import { defineTool, num, obj, opt, str } from "@tiny/core/define";

/** Fetch a URL and return its text (HTML is reduced to readable text). */
export default defineTool({
	name: "web_fetch",
	description: "Fetch a web page or API URL and return its content as text. Use for reading docs, articles, JSON APIs.",
	parameters: obj({
		url: str({ description: "Absolute http(s) URL" }),
		max_chars: opt(num({ description: "Truncate the result to this many characters (default 20000)" })),
	}),
	replay: "safe",
	async execute(args, _api, context) {
		const response = await fetch(args.url, {
			headers: { "user-agent": "tiny-assistant/0.1 (+self-hosted)" },
			signal: context.abortSignal
				? AbortSignal.any([context.abortSignal, AbortSignal.timeout(30_000)])
				: AbortSignal.timeout(30_000),
			redirect: "follow",
		});
		const type = response.headers.get("content-type") ?? "";
		let text = await response.text();
		if (type.includes("html")) {
			text = text
				.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "")
				.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
				.replace(/<[^>]+>/g, "")
				.replace(/&nbsp;/g, " ")
				.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
		}
		const max = args.max_chars ?? 20_000;
		const body = text.length > max ? `${text.slice(0, max)}\n…(truncated, ${text.length} chars total)` : text;
		return {
			output: [{ type: "text", text: `HTTP ${response.status} ${type}\n\n${body}` }],
			isError: !response.ok,
		};
	},
});
