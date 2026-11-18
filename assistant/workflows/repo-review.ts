import { defineWorkflow, obj, opt, str } from "@tiny/core/define";

/**
 * Review the uncommitted changes of the session's project. Each step is checkpointed: if the daemon restarts midway,
 * the run resumes after the last finished step.
 */
export default defineWorkflow({
	name: "repo-review",
	description: "Review uncommitted git changes in the project and suggest improvements",
	input: obj({ focus: opt(str({ description: "What to focus on, e.g. 'security' or 'naming'" })) }),
	async run(ctx) {
		const status = await ctx.exec("git status --short && git diff --stat", { step: "git-status" });
		if (status.exitCode !== 0) throw new Error(`Not a git repository?\n${status.output}`);
		if (!status.output.trim()) {
			await ctx.log("No uncommitted changes, nothing to review.");
			return { reviewed: false };
		}
		await ctx.log(`Changes:\n${status.output}`);
		const focus = ctx.input.focus ? ` Focus on ${ctx.input.focus}.` : "";
		const review = await ctx.agent(
			`Review the uncommitted changes in this repository (run \`git diff\` yourself).${focus} ` +
				"List concrete problems first (file:line, why it matters), then smaller suggestions. Do not edit files.",
			{ step: "review" },
		);
		return { reviewed: true, chars: review.length };
	},
});
