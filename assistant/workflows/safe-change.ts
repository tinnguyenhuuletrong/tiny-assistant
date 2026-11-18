import { bool, defineWorkflow, obj, opt, str } from "@tiny/core/define";

/**
 * Let the agent change the project on a throwaway git branch, then run the tests. If the tests fail (or you press
 * Stop), the rollback deletes the branch and puts you back where you were, so a failed attempt leaves nothing behind.
 * If they pass, the change is committed on the branch for you to review and merge.
 *
 * Try: /run safe-change {"task": "Add a --version flag to the CLI", "test": "bun test"}
 */
export default defineWorkflow({
	name: "safe-change",
	description: "Make a change on a temporary branch; keep it only if the tests pass (rolls back otherwise)",
	input: obj({
		task: str({ description: "What the agent should change" }),
		test: opt(str({ description: "Command that must succeed, default `bun test`" })),
		keepBranch: opt(bool({ description: "Keep the branch on failure for inspection" })),
	}),
	examples: [
		{
			label: "Add a --version flag",
			input: { task: "Add a --version flag to the CLI that prints the package version." },
		},
		{
			label: "Fix failing tests",
			input: { task: "Run the tests, find why they fail, and fix the code (not the tests).", test: "bun test" },
		},
	],
	async run(ctx) {
		// Without a project folder, commands would run in the daemon's own directory.
		if (!ctx.cwd) throw new Error("Run safe-change in a project: it needs the project's git repository.");
		const test = ctx.input.test ?? "bun test";
		const branch = `tiny/run-${ctx.runId}`;

		const status = await ctx.exec("git status --porcelain", { step: "check clean tree" });
		if (status.exitCode !== 0) throw new Error(`Not a git repository: ${status.output.trim()}`);
		// The rollback discards the branch's changes, so it must not start on top of uncommitted work.
		if (status.output.trim()) throw new Error("The working tree has uncommitted changes. Commit or stash them first.");

		const start = await ctx.exec("git rev-parse --abbrev-ref HEAD", { step: "remember branch" });
		const original = start.output.trim();
		const undoBranch = ctx.input.keepBranch
			? `git checkout -f ${original}`
			: `git checkout -f ${original} && git branch -D ${branch}`;
		await ctx.exec(`git checkout -b ${branch}`, { step: "create branch", undo: undoBranch });

		await ctx.agent(
			`${ctx.input.task}\n\nWork in this repository on the current branch (${branch}). Do not commit; I will run \`${test}\` after you finish.`,
			{ step: "make change" },
		);

		// `check` fails the step itself on a non-zero exit, so the diagram shows which step broke.
		const result = await ctx.exec(test, { step: "run tests", check: true, timeoutMs: 15 * 60_000 });
		await ctx.log(result.output.slice(-2000) || "(no output)");

		await ctx.exec(`git add -A && git commit -m ${JSON.stringify(`tiny: ${ctx.input.task}`.slice(0, 72))}`, {
			step: "commit",
		});
		return `Done on branch ${branch}. Review it, then merge into ${original}.`;
	},
});
