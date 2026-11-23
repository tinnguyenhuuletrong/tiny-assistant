/**
 * Claude Code's OpenTelemetry export (https://code.claude.com/docs/en/monitoring-usage), for both ways tiny runs
 * Claude Code: the Claude Code engine (the Agent SDK, one `claude` process per turn, given `telemetryEnv` with the
 * turn's tags) and the `claude-code` model provider of Tiny chats (pi-claude-code, one `claude -p` process per model
 * call, which inherits the daemon's environment: `enableDaemonTelemetry`).
 */
import type { ClaudeTelemetry } from "./config.ts";

/**
 * The environment that turns Claude Code's export on: metrics, events (logs), and traces over OTLP/HTTP protobuf to
 * `otel.endpoint`. Metrics are cumulative, which Prometheus-style backends store (Claude Code defaults to delta).
 * Every signal is exported each second, as the Agent SDK docs advise for short-lived processes: a turn's process lives
 * only for the turn, and what is still batched when it is killed is lost. Every variable already set in `base` (the
 * daemon's `.env`) wins, except `OTEL_RESOURCE_ATTRIBUTES`, which gets `tags` (replacing base entries with the same
 * key), so a backend can tie what Claude Code did to the tiny session that ran it.
 */
export function telemetryEnv(
	otel: ClaudeTelemetry,
	base: Record<string, string | undefined>,
	tags: Record<string, string | undefined>,
): Record<string, string> {
	const wanted: Record<string, string> = {
		CLAUDE_CODE_ENABLE_TELEMETRY: "1",
		CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
		OTEL_METRICS_EXPORTER: "otlp",
		OTEL_LOGS_EXPORTER: "otlp",
		OTEL_TRACES_EXPORTER: "otlp",
		OTEL_EXPORTER_OTLP_ENDPOINT: otel.endpoint,
		OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
		OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "cumulative",
		OTEL_METRIC_EXPORT_INTERVAL: "1000",
		OTEL_LOGS_EXPORT_INTERVAL: "1000",
		OTEL_TRACES_EXPORT_INTERVAL: "1000",
		...(otel.content
			? {
					OTEL_LOG_USER_PROMPTS: "1",
					OTEL_LOG_ASSISTANT_RESPONSES: "1",
					OTEL_LOG_TOOL_DETAILS: "1",
					OTEL_LOG_TOOL_CONTENT: "1",
				}
			: {}),
	};
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(wanted)) if (!base[key]) env[key] = value;
	const set = Object.entries(tags).filter((entry): entry is [string, string] => Boolean(entry[1]));
	if (set.length > 0) {
		const keys = new Set(set.map(([key]) => key));
		const kept = (base.OTEL_RESOURCE_ATTRIBUTES ?? "")
			.split(",")
			.filter((pair) => pair.trim() && !keys.has(pair.split("=")[0]?.trim() ?? ""));
		// Values are percent-encoded (W3C Baggage), so a path with commas or `=` stays one value.
		env.OTEL_RESOURCE_ATTRIBUTES = [...kept, ...set.map(([key, value]) => `${key}=${encodeURIComponent(value)}`)].join(
			",",
		);
	}
	return env;
}

/**
 * Turn the export on for every `claude` the daemon starts without its own environment: the `claude-code` model
 * provider of Tiny chats. Tagged `tiny.engine=pi`; each of its processes is one model call with a fresh Claude Code
 * `session.id`. Programs started by tools inherit the `OTEL_*` variables too.
 */
export function enableDaemonTelemetry(
	otel: ClaudeTelemetry | undefined,
	env: Record<string, string | undefined>,
): void {
	if (otel) Object.assign(env, telemetryEnv(otel, env, { "tiny.engine": "pi" }));
}
