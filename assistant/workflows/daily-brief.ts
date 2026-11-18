import { defineWorkflow, obj, opt, str } from "@tiny/core/define";

/** A minimal multi-step workflow: gather facts with steps, then let the agent write the brief. */
export default defineWorkflow({
	name: "daily-brief",
	description: "Summarize what changed in the project recently and propose today's priorities",
	input: obj({ since: opt(str({ description: "git --since value, default '1 day ago'" })) }),
	examples: [
		{ label: "Since yesterday", input: {} },
		{ label: "This week", input: { since: "1 week ago" } },
	],
	async run(ctx) {
		const since = ctx.input.since ?? "1 day ago";
		const log = await ctx.exec(`git log --since="${since.replace(/"/g, "")}" --oneline --no-merges | head -50`, {
			step: "git-log",
		});
		const todos = await ctx.exec(
			"grep -rn --include='*.ts' --include='*.md' -E 'TODO|FIXME' . | grep -v node_modules | head -30",
			{
				step: "todos",
			},
		);
		return ctx.agent(
			`Write a short daily brief for this project.\n\nCommits since ${since}:\n${log.output || "(none)"}\n\n` +
				`Open TODO/FIXME markers:\n${todos.output || "(none)"}\n\nGive: 1) what changed, 2) top 3 priorities for today.`,
			{ step: "brief" },
		);
	},
});
