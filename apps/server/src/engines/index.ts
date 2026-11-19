/**
 * The engines this daemon offers. `pi` is built in (the Harness runs it); the rest come from `Engine` implementations.
 * New engines (Codex, Antigravity, ...) are added in `createEngines`.
 */
import type { EngineInfo, MediaSupport } from "@tiny/core/protocol";
import { INLINE_IMAGE_TYPES } from "../attachments.ts";
import type { Config } from "../config.ts";
import { createClaudeCodeEngine } from "./claude-code.ts";
import type { Engine } from "./types.ts";

export type { Engine } from "./types.ts";

export const PI_ENGINE = "pi";

const PI_NOTE =
	"tiny's own agent loop on pi-durable: every model turn and tool call is committed and picks up after a restart. Uses tiny's tools (read, write, edit, bash, assistant/tools), workflows, and any configured model provider.";

/** pi gives the model images (when the model takes them); other files reach it as paths. */
export const PI_MEDIA = { inline: INLINE_IMAGE_TYPES };

export function createEngines(config: Config): Engine[] {
	const engines: Engine[] = [];
	if (config.engines.includes("claude-code")) engines.push(createClaudeCodeEngine(config.claude));
	return engines;
}

export class EngineRegistry {
	readonly #engines = new Map<string, Engine>();

	constructor(
		engines: readonly Engine[],
		/** The daemon's upload limit, the default for each engine's `maxFileBytes`. */
		readonly maxFileBytes: number,
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

	/** What an engine takes besides text (pi: images, when `model` takes images). */
	media(id: string, model?: { input?: string[] }): MediaSupport {
		const engine = this.#engines.get(id);
		if (!engine) {
			const images = !model?.input || model.input.includes("image");
			return { inline: images ? [...PI_MEDIA.inline] : [], maxFileBytes: this.maxFileBytes };
		}
		return {
			inline: [...engine.media.inline],
			maxFileBytes: Math.min(engine.media.maxFileBytes ?? this.maxFileBytes, this.maxFileBytes),
		};
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
				media: this.media(PI_ENGINE),
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
				media: this.media(engine.id),
			});
		}
		return list;
	}
}
