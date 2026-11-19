/**
 * Claude Code as an engine, through the Claude Agent SDK. Each turn runs the `claude` CLI on the PATH, in the session's
 * project folder, the way `claude` itself starts there: user, project, and local settings, so CLAUDE.md, skills,
 * plugins, hooks, MCP servers, and permission rules all load; Claude in Chrome on; permissions bypassed by default.
 * Claude Code keeps its own session (resumed by id on every turn); tiny records the turn into the pi-durable session.
 *
 * Unlike the `claude-code` model provider (pi-claude-code), which uses Claude Code only to reach the model, here Claude
 * Code runs the whole turn: its own tools, its own context management.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
	type EffortLevel,
	type Options,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isImage } from "@tiny/core/media";
import type { ThinkingLevel } from "@tiny/core/protocol";
import { INLINE_IMAGE_TYPES, promptWithAttachments } from "../attachments.ts";
import {
	type AssistantMessageData,
	type Engine,
	emptyUsage,
	type TextBlock,
	type ThinkingBlock,
	type ToolCallBlock,
	type ToolResultMessageData,
	type TurnEvent,
	type TurnInput,
	type UsageData,
} from "./types.ts";

export type ClaudeCodeEngineOptions = {
	/** The `claude` executable: a name on the PATH or a path. */
	command: string;
	/** Claude Code's permission mode; `bypassPermissions` is what `claude --dangerously-skip-permissions` does. */
	permissionMode: NonNullable<Options["permissionMode"]>;
	/** Claude in Chrome: true `--chrome`, false `--no-chrome`, undefined whatever your settings say. */
	chrome: boolean | undefined;
	/** Keep `ANTHROPIC_API_KEY` for the CLI (API billing). Off: it uses your Claude login, like pi-claude-code. */
	useApiKey: boolean;
};

/** Longest tool result text kept in the transcript; Claude Code already bounds what the model sees. */
const MAX_RESULT_TEXT = 100_000;

const EFFORT: Record<Exclude<ThinkingLevel, "off">, EffortLevel> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
};

function resolveCommand(command: string): string | undefined {
	if (command.includes("/")) return existsSync(command) ? command : undefined;
	return Bun.which(command) ?? undefined;
}

export function createClaudeCodeEngine(options: ClaudeCodeEngineOptions): Engine {
	const permissions =
		options.permissionMode === "bypassPermissions" ? "full permissions" : `permission mode ${options.permissionMode}`;
	return {
		id: "claude-code",
		name: "Claude Code",
		note: `Runs Claude Code itself in the project, set up like \`claude\` there: your skills, plugins, hooks, MCP servers, CLAUDE.md${options.chrome === false ? "" : ", and Claude in Chrome"}, with ${permissions}. Its turns are recorded in this session.`,
		modelProviders: ["claude-code"],
		// Claude takes images and PDFs as content; anything else reaches it as a path its Read and Bash tools can open.
		media: { inline: [...INLINE_IMAGE_TYPES, "application/pdf"] },
		availability() {
			if (resolveCommand(options.command)) return { available: true };
			return {
				available: false,
				reason: `\`${options.command}\` is not on the PATH. Install Claude Code and run \`claude auth login\`.`,
			};
		},
		run: (input) => runTurn(options, input),
	};
}

async function* runTurn(options: ClaudeCodeEngineOptions, input: TurnInput): AsyncGenerator<TurnEvent> {
	const executable = resolveCommand(options.command);
	if (!executable) throw new Error(`\`${options.command}\` is not on the PATH`);
	const abortController = new AbortController();
	const stop = () => abortController.abort();
	if (input.signal.aborted) stop();
	input.signal.addEventListener("abort", stop, { once: true });

	const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "tiny-assistant" };
	if (!options.useApiKey) delete env.ANTHROPIC_API_KEY;
	const extraArgs: Record<string, string | null> = {};
	if (options.chrome === true) extraArgs.chrome = null;
	if (options.chrome === false) extraArgs["no-chrome"] = null;
	const stderr: string[] = [];

	const turn = query({
		prompt: input.attachments.length > 0 ? userMessage(input) : input.prompt,
		options: {
			abortController,
			cwd: input.cwd ?? homedir(),
			// Attached files live in tiny's data folder: let Claude Code's tools reach them in any permission mode.
			...(input.attachments.length > 0
				? { additionalDirectories: [...new Set(input.attachments.map((attachment) => dirname(attachment.path)))] }
				: {}),
			pathToClaudeCodeExecutable: executable,
			env,
			extraArgs,
			settingSources: ["user", "project", "local"],
			systemPrompt: { type: "preset", preset: "claude_code" },
			tools: { type: "preset", preset: "claude_code" },
			permissionMode: options.permissionMode,
			allowDangerouslySkipPermissions: options.permissionMode === "bypassPermissions",
			includePartialMessages: true,
			...(input.resume ? { resume: input.resume } : {}),
			...(input.model && input.model !== "default" ? { model: input.model } : {}),
			...(input.thinking === "off"
				? { thinking: { type: "disabled" } as const }
				: input.thinking
					? { effort: EFFORT[input.thinking] }
					: {}),
			stderr: (data) => {
				stderr.push(data);
				if (stderr.length > 50) stderr.shift();
			},
		},
	});

	const translator = new ClaudeTranslator(input.resume === null);
	let finished = false;
	try {
		for await (const message of turn) {
			for (const event of translator.push(message)) {
				if (event.type === "done") finished = true;
				yield event;
			}
			if (finished) break;
		}
	} catch (error) {
		if (input.signal.aborted) throw error;
		const tail = stderr.join("").trim().split("\n").slice(-5).join("\n");
		throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n${tail}` : ""}`);
	} finally {
		input.signal.removeEventListener("abort", stop);
		if (!finished) turn.close();
	}
	if (!finished) {
		for (const event of translator.flush()) yield event;
		const tail = stderr.join("").trim().split("\n").slice(-5).join("\n");
		yield { type: "done", error: `Claude Code ended without a result${tail ? `: ${tail}` : ""}` };
	}
}

/**
 * The turn's message as content blocks: the text (with every file's path), then images and PDFs as Claude takes them.
 * Sent as streaming input, which ends after this one message, so Claude Code exits when the turn is done.
 */
async function* userMessage(input: TurnInput): AsyncGenerator<SDKUserMessage> {
	const content: unknown[] = [{ type: "text", text: promptWithAttachments(input.prompt, input.attachments) }];
	for (const attachment of input.attachments) {
		const inline = attachment.inline;
		if (!inline) continue;
		if (isImage(inline.mimeType)) {
			content.push({ type: "image", source: { type: "base64", media_type: inline.mimeType, data: inline.data } });
		} else if (inline.mimeType === "application/pdf") {
			content.push({
				type: "document",
				title: attachment.name,
				source: { type: "base64", media_type: "application/pdf", data: inline.data },
			});
		}
	}
	yield {
		type: "user",
		message: { role: "user", content: content as SDKUserMessage["message"]["content"] },
		parent_tool_use_id: null,
		origin: { kind: "human" },
	};
}

type Block = TextBlock | ThinkingBlock | ToolCallBlock;
type RawBlock = { type: string; [key: string]: unknown };

/**
 * Turns Claude Code's stream into turn events. Claude Code sends one `assistant` message per finished content block
 * (blocks of one API response share `message.id`), raw stream events for the block being written, `user` messages with
 * the tool results, and a `result` at the end. Subagent traffic (`parent_tool_use_id` set) is left out: the subagent's
 * report comes back as its tool call's result.
 */
export class ClaudeTranslator {
	#pending: { id: string; message: AssistantMessageData } | null = null;
	#streaming: Block | null = null;
	#json = "";
	readonly #toolNames = new Map<string, string>();
	#model = "claude";

	constructor(readonly firstTurn: boolean) {}

	push(message: SDKMessage): TurnEvent[] {
		const events: TurnEvent[] = [];
		const raw = message as unknown as Record<string, unknown>;
		if (raw.parent_tool_use_id) return events;
		switch (message.type) {
			case "system": {
				if (message.subtype === "init") {
					this.#model = message.model || this.#model;
					events.push({ type: "session", id: message.session_id });
					const notice = initNotice(message, this.firstTurn);
					if (notice) events.push(notice);
				} else if (message.subtype === "api_retry") {
					events.push({ type: "retry", at: Date.now() + message.retry_delay_ms, error: String(message.error) });
				} else if (message.subtype === "compact_boundary") {
					const meta = message.compact_metadata;
					events.push({
						type: "notice",
						level: "info",
						text: `Claude Code compacted its context (${meta.pre_tokens}${meta.post_tokens ? ` → ${meta.post_tokens}` : ""} tokens)`,
					});
				}
				return events;
			}
			case "stream_event": {
				const event = message.event as unknown as Record<string, unknown>;
				if (event.type === "message_start") {
					const started = event.message as { id: string; model?: string };
					if (this.#pending && this.#pending.id !== started.id) events.push(...this.flush());
					this.#ensure(started.id, started.model);
				} else if (event.type === "content_block_start") {
					this.#streaming = convertBlock(event.content_block as RawBlock);
					this.#json = "";
				} else if (event.type === "content_block_delta" && this.#streaming) {
					const delta = event.delta as Record<string, unknown>;
					const block = this.#streaming;
					if (delta.type === "text_delta" && block.type === "text") block.text += String(delta.text ?? "");
					else if (delta.type === "thinking_delta" && block.type === "thinking")
						block.thinking += String(delta.thinking ?? "");
					else if (delta.type === "input_json_delta" && block.type === "toolCall") {
						this.#json += String(delta.partial_json ?? "");
						const parsed = parsePartialJson(this.#json);
						if (parsed) block.arguments = parsed;
					} else return events;
				} else return events;
				const partial = this.#snapshot();
				if (partial) events.push({ type: "partial", message: partial });
				return events;
			}
			case "assistant": {
				const id = message.message.id;
				if (this.#pending && this.#pending.id !== id) events.push(...this.flush());
				const pending = this.#ensure(id, message.message.model);
				for (const raw of message.message.content as unknown as RawBlock[]) {
					const block = convertBlock(raw);
					if (!block) continue;
					if (block.type === "toolCall") this.#toolNames.set(block.id, block.name);
					pending.message.content.push(block);
				}
				if (message.error) pending.message.errorMessage = String(message.error);
				this.#streaming = null;
				const partial = this.#snapshot();
				if (partial) events.push({ type: "partial", message: partial });
				return events;
			}
			case "user": {
				const content = message.message.content;
				if (!Array.isArray(content)) return events;
				const results = (content as unknown as RawBlock[]).filter((block) => block.type === "tool_result");
				if (results.length === 0) return events;
				events.push(...this.flush());
				for (const block of results) {
					const toolCallId = String(block.tool_use_id);
					events.push({
						type: "toolResult",
						message: {
							role: "toolResult",
							toolCallId,
							toolName: this.#toolNames.get(toolCallId) ?? "tool",
							content: convertResultContent(block.content),
							isError: Boolean(block.is_error),
							timestamp: Date.now(),
						},
					});
				}
				return events;
			}
			case "result": {
				const usage = convertUsage(message.usage as unknown as Record<string, number | undefined>);
				const error = message.is_error
					? ("errors" in message && message.errors.length > 0
							? message.errors.join("; ")
							: "result" in message
								? message.result
								: message.subtype) || "Claude Code reported an error"
					: undefined;
				if (this.#pending && error) this.#pending.message.errorMessage ??= error;
				events.push(...this.flush());
				events.push({
					type: "done",
					usage,
					cumulativeCost: message.total_cost_usd,
					...(error ? { error } : {}),
				});
				return events;
			}
			default:
				return events;
		}
	}

	/** Emit the assistant message in progress as finished. */
	flush(): TurnEvent[] {
		const pending = this.#pending;
		this.#pending = null;
		this.#streaming = null;
		if (!pending || pending.message.content.length === 0) return [];
		const message = pending.message;
		message.stopReason = message.errorMessage
			? "error"
			: message.content.some((block) => block.type === "toolCall")
				? "toolUse"
				: "stop";
		return [{ type: "assistant", message }];
	}

	#ensure(id: string, model: string | undefined): { id: string; message: AssistantMessageData } {
		if (model) this.#model = model;
		if (!this.#pending) {
			this.#pending = {
				id,
				message: {
					role: "assistant",
					content: [],
					api: "claude-code-native",
					provider: "claude-code",
					model: this.#model,
					usage: emptyUsage(),
					stopReason: "stop",
					timestamp: Date.now(),
				},
			};
		}
		return this.#pending;
	}

	#snapshot(): AssistantMessageData | null {
		if (!this.#pending) return null;
		const content = this.#streaming
			? [...this.#pending.message.content, { ...this.#streaming }]
			: [...this.#pending.message.content];
		if (content.length === 0) return null;
		return { ...this.#pending.message, content };
	}
}

function convertBlock(block: RawBlock | undefined): Block | null {
	if (!block) return null;
	switch (block.type) {
		case "text":
			return { type: "text", text: String(block.text ?? "") };
		case "thinking":
			return {
				type: "thinking",
				thinking: String(block.thinking ?? ""),
				...(block.signature ? { thinkingSignature: String(block.signature) } : {}),
			};
		case "redacted_thinking":
			return { type: "thinking", thinking: "", redacted: true };
		case "tool_use":
		case "server_tool_use":
		case "mcp_tool_use":
			return {
				type: "toolCall",
				id: String(block.id),
				name: String(block.name),
				arguments: (block.input as Record<string, unknown>) ?? {},
			};
		default:
			return null;
	}
}

function convertResultContent(content: unknown): ToolResultMessageData["content"] {
	if (typeof content === "string") return [{ type: "text", text: clip(content) }];
	if (!Array.isArray(content)) return [];
	const out: ToolResultMessageData["content"] = [];
	for (const block of content as RawBlock[]) {
		if (block.type === "text") out.push({ type: "text", text: clip(String(block.text ?? "")) });
		else if (block.type === "image") {
			const source = block.source as { type?: string; media_type?: string; data?: string } | undefined;
			if (source?.type === "base64" && source.data)
				out.push({ type: "image", data: source.data, mimeType: source.media_type ?? "image/png" });
		}
	}
	return out;
}

function clip(text: string): string {
	return text.length > MAX_RESULT_TEXT ? `${text.slice(0, MAX_RESULT_TEXT)}\n…(truncated)` : text;
}

function convertUsage(usage: Record<string, number | undefined> | undefined): UsageData {
	const result = emptyUsage();
	if (!usage) return result;
	result.input = usage.input_tokens ?? 0;
	result.output = usage.output_tokens ?? 0;
	result.cacheRead = usage.cache_read_input_tokens ?? 0;
	result.cacheWrite = usage.cache_creation_input_tokens ?? 0;
	result.totalTokens = result.input + result.output + result.cacheRead + result.cacheWrite;
	return result;
}

/** Arguments of a tool call still streaming in: the JSON so far, closed, if that parses. */
function parsePartialJson(text: string): Record<string, unknown> | undefined {
	for (const suffix of ["", '"}', "}", '"]}', "]}"]) {
		try {
			const value = JSON.parse(text + suffix);
			if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
		} catch {}
	}
	return undefined;
}

/**
 * What Claude Code loaded, shown on a session's first turn, and on later turns only when an MCP server failed.
 * Connected servers are named; the rest are counted by status (connectors still connecting or needing a login are
 * normal and not a warning).
 */
function initNotice(message: Extract<SDKMessage, { type: "system"; subtype: "init" }>, firstTurn: boolean) {
	const failed = message.mcp_servers.filter((server) => server.status === "failed");
	if (!firstTurn && failed.length === 0) return undefined;
	const connected = message.mcp_servers.filter((server) => server.status === "connected").map((server) => server.name);
	const others = new Map<string, number>();
	for (const server of message.mcp_servers) {
		if (server.status === "connected" || server.status === "failed") continue;
		others.set(server.status, (others.get(server.status) ?? 0) + 1);
	}
	const shown = connected.slice(0, 6);
	const mcp = [
		...(shown.length > 0
			? [`${shown.join(", ")}${connected.length > shown.length ? ` +${connected.length - shown.length}` : ""}`]
			: []),
		...(failed.length > 0 ? [`failed: ${failed.map((server) => server.name).join(", ")}`] : []),
		...[...others].map(([status, count]) => `${count} ${status}`),
	];
	const parts = [
		`Claude Code ${message.claude_code_version}`,
		message.model,
		message.permissionMode,
		`${message.tools.length} tools`,
		mcp.length > 0 ? `MCP: ${mcp.join("; ")}` : "no MCP servers",
		`${message.skills.length} skills`,
		...(message.plugins.length > 0 ? [`${message.plugins.length} plugins`] : []),
	];
	return {
		type: "notice" as const,
		level: failed.length > 0 ? ("warn" as const) : ("info" as const),
		text: parts.join(" · "),
	};
}
