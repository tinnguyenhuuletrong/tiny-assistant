/**
 * The engines this daemon offers. `pi` is built in (the Harness runs it); the rest come from `Engine` implementations.
 * New engines (Codex, Antigravity, ...) are added in `createEngines`.
 */
import type { EngineInfo } from "@tiny/core/protocol";
import type { Config } from "../config.ts";
import { createClaudeCodeEngine } from "./claude-code.ts";
import type { Engine } from "./types.ts";

export type { Engine } from "./types.ts";

export const PI_ENGINE = "pi";

const PI_NOTE =
	"tiny's own agent loop on pi-durable: every model turn and tool call is committed and picks up after a restart. Uses tiny's tools (read, write, edit, bash, assistant/tools), workflows, and any configured model provider.";

export function createEngines(config: Config): Engine[] {
	const engines: Engine[] = [];
	if (config.engines.includes("claude-code")) engines.push(createClaudeCodeEngine(config.claude));
	return engines;
}

export class EngineRegistry {
	readonly #engines = new Map<string, Engine>();

	constructor(
		engines: readonly Engine[],
		/** Whether the pi engine is offered at all. */
		readonly pi = true,
	) {
		for (const engine of engines) this.#engines.set(engine.id, engine);
	}

	/** An external engine by id; undefined for `pi` and unknown ids. */
	get(id: string): Engine | undefined {
		return this.#engines.get(id);
	}

	has(id: string): boolean {
		return (id === PI_ENGINE && this.pi) || this.#engines.has(id);
	}

	list(piAvailable: boolean): EngineInfo[] {
		const list: EngineInfo[] = [];
		if (this.pi) {
			list.push({
				id: PI_ENGINE,
				name: "Tiny",
				note: PI_NOTE,
				available: piAvailable,
				...(piAvailable ? {} : { reason: "No model provider is available" }),
				steer: true,
				compact: true,
				workflows: true,
			});
		}
		for (const engine of this.#engines.values()) {
			const { available, reason } = engine.availability();
			list.push({
				id: engine.id,
				name: engine.name,
				note: engine.note,
				available,
				...(reason ? { reason } : {}),
				...(engine.modelProviders ? { modelProviders: engine.modelProviders } : {}),
				steer: false,
				compact: true,
				workflows: false,
			});
		}
		return list;
	}
}
