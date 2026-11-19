/**
 * Model providers. Claude Code (your Claude Pro/Max subscription, through the `claude` CLI) is on by default; any
 * pi-ai built-in provider (anthropic, openai, google, openrouter, ollama-compatible, ...) can be added with
 * `TINY_PROVIDERS=claude-code,openai,...` and that provider's usual API key variable.
 */

import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createClaudeCodeProvider } from "@earendil-works/pi-claude-code/src/provider.ts";
import type { ModelInfo } from "@tiny/core/protocol";

export const CLAUDE_CODE = "claude-code";

export function createModelRegistry(enabled: string[]): MutableModels {
	const models = createModels();
	const wanted = new Set(enabled.length > 0 ? enabled : [CLAUDE_CODE]);
	if (wanted.has(CLAUDE_CODE)) models.setProvider(createClaudeCodeProvider());
	for (const provider of builtinProviders()) {
		if (wanted.has(provider.id)) models.setProvider(provider);
	}
	return models;
}

/** Discover dynamic catalogs (Claude Code asks the CLI) and list the models whose providers are configured. */
export async function availableModels(models: MutableModels): Promise<ModelInfo[]> {
	const refreshed = await models.refresh();
	for (const [provider, error] of Object.entries(refreshed.errors ?? {})) {
		console.warn(`[models] ${provider}: ${String(error)}`);
	}
	const available = await models.getAvailable();
	return available.map((model) => ({
		provider: model.provider,
		id: model.id,
		name: model.name ?? model.id,
		reasoning: Boolean((model as { reasoning?: boolean }).reasoning),
		contextWindow: (model as { contextWindow?: number }).contextWindow,
		...(Array.isArray((model as { input?: unknown }).input) ? { input: (model as { input: string[] }).input } : {}),
	}));
}

export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function parseModelKey(key: string): { provider: string; modelId: string } {
	const slash = key.indexOf("/");
	if (slash <= 0) throw new Error(`Model must be "provider/modelId", got "${key}"`);
	return { provider: key.slice(0, slash), modelId: key.slice(slash + 1) };
}

/** Preference order when no default model is configured. */
const PREFERRED = ["claude-code/claude-sonnet-5-5", "claude-code/claude-opus-5-5", "claude-code/default"];

export function pickDefaultModel(models: ModelInfo[], configured: string | undefined): string | null {
	const keys = models.map(modelKey);
	if (configured && keys.includes(configured)) return configured;
	if (configured) console.warn(`[models] TINY_DEFAULT_MODEL ${configured} is not available`);
	return PREFERRED.find((key) => keys.includes(key)) ?? keys[0] ?? null;
}
