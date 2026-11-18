import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineWorkflow, int, obj, opt, str } from "@tiny/core/define";

/**
 * A review loop with a person in it: the agent drafts release notes from the git history, then asks you to publish,
 * revise, or cancel. "Revise" asks what to change and drafts again (up to `maxRevisions`). "Publish" writes
 * RELEASE_NOTES.md; if anything after that fails, or you press Stop, the file is removed again.
 */
export default defineWorkflow({
	name: "release-notes",
	description: "Draft release notes with the agent, review them, revise until you publish",
	input: obj({
		since: opt(str({ description: "git ref or date to start from, default the latest tag (or 2 weeks ago)" })),
		maxRevisions: opt(int({ description: "How many revision rounds to allow, default 3" })),
	}),
	examples: [
		{ label: "Since the last tag", input: {} },
		{ label: "Last week", input: { since: "1 week ago" } },
	],
	async run(ctx) {
		if (!ctx.cwd) throw new Error("Run release-notes in a project: it reads the project's git history.");
		const since = ctx.input.since;
		const range = since
			? `--since="${since.replace(/"/g, "")}"`
			: '$(git describe --tags --abbrev=0 2>/dev/null && echo "..HEAD" || echo "--since=\'2 weeks ago\'")';
		const history = await ctx.exec(`git log ${range} --no-merges --pretty='- %s (%h)' | head -80`, {
			step: "collect commits",
			check: true,
		});
		if (!history.output.trim()) return "No commits to write notes about.";

		let draft = await ctx.agent(
			`Write concise release notes in Markdown from these commits. Group them under "Features", "Fixes", and "Other" (skip empty groups). Reply with the notes only.\n\n${history.output}`,
			{ step: "draft" },
		);
		const rounds = ctx.input.maxRevisions ?? 3;
		for (let round = 1; ; round++) {
			const choices = round <= rounds ? ["Publish", "Revise", "Cancel"] : ["Publish", "Cancel"];
			const decision = await ctx.ask("Publish these release notes? (the draft is above)", {
				key: `review-${round}`,
				choices,
			});
			if (decision === "Cancel") throw new Error("Cancelled during review");
			if (decision === "Publish") break;
			const feedback = await ctx.ask("What should change?", {
				key: `feedback-${round}`,
				placeholder: "e.g. shorter, mention the new sync feature first",
			});
			draft = await ctx.agent(`Revise the release notes: ${feedback}\n\nReply with the full notes only.`, {
				step: `revise-${round}`,
			});
		}

		const file = join(ctx.cwd, "RELEASE_NOTES.md");
		await ctx.step(
			"publish",
			() => {
				const existed = existsSync(file);
				writeFileSync(file, `${draft.trim()}\n`);
				return { file, existed };
			},
			// Only remove a file this run created; never delete one that was there before.
			{
				undo: (published: { file: string; existed: boolean }) =>
					published.existed ? undefined : rmSync(published.file, { force: true }),
			},
		);
		return `Published ${file}`;
	},
});
