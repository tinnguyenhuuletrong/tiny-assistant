import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, num, obj, opt, str } from "@tiny/core/define";

/**
 * Human in the loop, without a model: reserve budget, ask a person to approve, then pay. The run waits for the answer
 * without holding a process (it survives restarts), and the question shows up in the web app and the TUI (`/answer`).
 * Reject, Stop, or no answer in time rolls the reservation back.
 *
 * The "budget" is a JSON file in the temp directory: cat "$TMPDIR/tiny-assistant-demo-budget.json"
 */

type Reservation = { id: string; amount: number; released: boolean; paid: boolean };
const BUDGET = join(tmpdir(), "tiny-assistant-demo-budget.json");

function read(): Reservation[] {
	return existsSync(BUDGET) ? (JSON.parse(readFileSync(BUDGET, "utf8")) as Reservation[]) : [];
}

function update(id: string, change: Partial<Reservation>): void {
	writeFileSync(
		BUDGET,
		JSON.stringify(
			read().map((r) => (r.id === id ? { ...r, ...change } : r)),
			null,
			2,
		),
	);
}

export default defineWorkflow({
	name: "expense-approval",
	description: "Reserve budget, ask a person to approve, then pay (reject or timeout rolls back)",
	input: obj({
		description: str({ description: "What the expense is for" }),
		amount: num({ description: "Amount to approve" }),
		answerWithinMinutes: opt(num({ description: "Roll back if nobody answers in time" })),
	}),
	examples: [
		{ label: "Team lunch", input: { description: "Team lunch", amount: 180 } },
		{
			label: "Laptop (answer within 5 min)",
			input: { description: "New laptop", amount: 2400, answerWithinMinutes: 5 },
		},
	],
	async run(ctx) {
		const { description, amount, answerWithinMinutes } = ctx.input;
		const reservation = await ctx.step(
			"reserve budget",
			() => {
				const id = `run-${ctx.runId}`;
				const existing = read().find((r) => r.id === id);
				if (existing) return existing; // idempotent if this step reruns
				const created: Reservation = { id, amount, released: false, paid: false };
				writeFileSync(BUDGET, JSON.stringify([...read(), created], null, 2));
				return created;
			},
			{ undo: (reserved: Reservation) => update(reserved.id, { released: true }) },
		);
		await ctx.log(`Reserved ${amount} for "${description}"`);

		const decision = await ctx.ask(`Approve ${amount} for "${description}"?`, {
			choices: ["Approve", "Reject"],
			...(answerWithinMinutes ? { timeoutMs: answerWithinMinutes * 60_000 } : {}),
		});
		if (decision !== "Approve") throw new Error(`Rejected: "${description}" (${amount})`);

		await ctx.step("pay", () => {
			update(reservation.id, { paid: true });
			return { paid: amount };
		});
		return `Paid ${amount} for "${description}"`;
	},
});
