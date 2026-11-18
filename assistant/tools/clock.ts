import { defineTool, obj, opt, str } from "@tiny/core/define";

/** A tiny example tool: the current date and time in any timezone. */
export const now = defineTool({
	name: "now",
	description: "Get the current date and time, optionally in an IANA timezone like Asia/Ho_Chi_Minh.",
	parameters: obj({ timezone: opt(str()) }),
	replay: "safe",
	async execute(args) {
		const zone = args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		const text = new Date().toLocaleString("en-GB", { timeZone: zone, dateStyle: "full", timeStyle: "long" });
		return { output: [{ type: "text", text: `${text} (${zone})` }] };
	},
});
