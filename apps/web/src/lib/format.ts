import type { ModelInfo, UsageInfo } from "@tiny/core";

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number): string {
	if (usd === 0) return "$0";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}

export function usageText(usage: UsageInfo): string {
	const parts = [`${formatTokens(usage.input)} in`, `${formatTokens(usage.output)} out`];
	if (usage.cacheRead > 0) parts.push(`${formatTokens(usage.cacheRead)} cached`);
	if (usage.cost > 0) parts.push(formatCost(usage.cost));
	return parts.join(" · ");
}

export function relativeTime(at: number, now = Date.now()): string {
	const seconds = Math.round((now - at) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** `provider/modelId` of a model. */
export const modelKey = (model: ModelInfo) => `${model.provider}/${model.id}`;

/** A readable name for a `provider/modelId` key or a bare model id. */
export function modelName(models: readonly ModelInfo[] | undefined, key: string | null | undefined): string {
	if (!key) return "Default model";
	const found = models?.find((model) => modelKey(model) === key) ?? models?.find((model) => model.id === key);
	if (found) return found.name || found.id;
	const slash = key.indexOf("/");
	return slash >= 0 ? key.slice(slash + 1) : key;
}

export function basename(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed;
}

export function cn(...classes: (string | false | null | undefined)[]): string {
	return classes.filter(Boolean).join(" ");
}
