import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arr, defineWorkflow, num, obj, opt, str } from "@tiny/core/define";

/**
 * A saga, after the checkout example in "pi-durable" (earendil.com/posts/pi-durable): split a payment across cards.
 * Every charge is a step with an `undo` (a refund). If a card is declined, or you press Stop, the charges that went
 * through are refunded newest first, and each refund is checkpointed, so a crash mid-rollback never refunds twice.
 *
 * The "bank" is a JSON ledger in the temp directory, so you can watch charges and refunds land:
 *   cat "$TMPDIR/tiny-assistant-demo-bank.json"
 * Try: /run checkout {"amount": 90, "cards": ["visa-4242", "amex-0005", "mc-4444"], "decline": "amex-0005"}
 */

type Charge = { id: string; card: string; amount: number; refunded: boolean };
const LEDGER = join(tmpdir(), "tiny-assistant-demo-bank.json");

function readLedger(): Charge[] {
	return existsSync(LEDGER) ? (JSON.parse(readFileSync(LEDGER, "utf8")) as Charge[]) : [];
}

const bank = {
	/** Idempotent by `id`, like a real payment API's idempotency key: a retried charge returns the first one. */
	charge(id: string, card: string, amount: number, decline: boolean): Charge {
		const ledger = readLedger();
		const existing = ledger.find((charge) => charge.id === id);
		if (existing) return existing;
		if (decline) throw new Error(`Card ${card} was declined`);
		const charge = { id, card, amount, refunded: false };
		writeFileSync(LEDGER, JSON.stringify([...ledger, charge], null, 2));
		return charge;
	},
	refund(id: string): void {
		const ledger = readLedger().map((charge) => (charge.id === id ? { ...charge, refunded: true } : charge));
		writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
	},
};

export default defineWorkflow({
	name: "checkout",
	description: "Split a payment across cards; if one is declined, refund the others (saga with rollback)",
	input: obj({
		amount: num({ description: "Total to charge" }),
		cards: arr(str(), { minItems: 1, description: "Card ids to split the amount across" }),
		decline: opt(str({ description: "Simulate a declined card (one of the card ids)" })),
	}),
	examples: [
		{ label: "All cards go through", input: { amount: 90, cards: ["visa-4242", "mc-4444", "amex-0005"] } },
		{
			label: "One card is declined (rollback)",
			input: { amount: 120, cards: ["visa-4242", "mc-4444", "jcb-3530", "amex-0005"], decline: "amex-0005" },
		},
	],
	async run(ctx) {
		const { amount, cards, decline } = ctx.input;
		const share = Math.round((amount / cards.length) * 100) / 100;
		const receipts: string[] = [];
		for (const card of cards) {
			const charge = await ctx.step(
				`charge ${card}`,
				async () => {
					await Bun.sleep(600); // a real payment API takes a moment; makes the run easy to watch
					return bank.charge(`run-${ctx.runId}-${card}`, card, share, card === decline);
				},
				{
					undo: async (charged: Charge) => {
						await Bun.sleep(400);
						bank.refund(charged.id);
					},
				},
			);
			receipts.push(charge.id);
			await ctx.log(`Charged ${share} to ${card}`);
		}
		await ctx.step("place order", async () => {
			await Bun.sleep(400);
			return { order: `order-${ctx.runId}`, receipts };
		});
		return `Order placed: ${amount} across ${cards.length} card(s)`;
	},
});
