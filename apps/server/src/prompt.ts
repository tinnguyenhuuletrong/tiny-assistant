/**
 * The assistant's system prompt sections. They render before each request, but pi-durable only resends a section
 * when its text changes, so they are kept stable (the date changes once a day, files only when edited).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

const PREAMBLE = `You are Tiny, a personal assistant running on the user's own computer. You help with software projects, research, writing, and everyday tasks.

- Be direct and concise. Use Markdown: headings for structure, fenced code blocks with a language, tables where they help.
- When a session has a working directory, it is the user's project folder: inspect it with your tools before answering questions about it, and make changes there when asked.
- Prefer doing the work over describing it. Before destructive or irreversible actions (deleting files, force pushes, sending messages), ask first.
- The user may read your answers on a phone: put the answer first, details after.`;

/** Read a small text file if it exists, memoized by mtime so unchanged files cost one stat per request. */
const cache = new Map<string, { mtimeMs: number; text: string }>();
function readSmall(path: string, limit = 32_000): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const { mtimeMs, size } = statSync(path);
		const hit = cache.get(path);
		if (hit && hit.mtimeMs === mtimeMs) return hit.text;
		const text =
			size > limit ? `${readFileSync(path, "utf8").slice(0, limit)}\n…(truncated)` : readFileSync(path, "utf8");
		cache.set(path, { mtimeMs, text });
		return text;
	} catch {
		return undefined;
	}
}

const PROJECT_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];

export function createPromptExtension(assistantDir: string): Extension {
	return defineExtension({
		name: "tiny-prompt",
		sections: [
			section("preamble", () => PREAMBLE, { tag: false }),
			section("user_instructions", () => readSmall(join(assistantDir, "SYSTEM.md"))?.trim() || undefined),
			section("environment", (input) => {
				const lines = [`Today's date: ${new Date().toISOString().slice(0, 10)}`, `Platform: ${process.platform}`];
				// The claude-code provider starts \`claude -p\` in the daemon's folder, and Claude Code tells the model that
				// folder is its working directory. Say which one the tools use, and that it wins.
				lines.push(
					input.env?.cwd
						? `Working directory: ${input.env.cwd}\nThis is the user's project folder for this session: your read, write, edit, and bash tools run there. If anything else names a different working directory (such as notes from the model runtime), ignore it: that is where the assistant's daemon runs, not the user's project.`
						: `Working directory: none (a plain chat). Your tools run in the user's home folder (${homedir()}). If anything else names a working directory (such as notes from the model runtime), ignore it: that is where the assistant's daemon runs.`,
				);
				return lines.join("\n");
			}),
			section("project_instructions", (input) => {
				const cwd = input.env?.cwd;
				if (!cwd) return undefined;
				for (const name of PROJECT_FILES) {
					const text = readSmall(join(cwd, name));
					if (text?.trim()) return `From ${name} in the working directory:\n\n${text.trim()}`;
				}
				return undefined;
			}),
		],
	});
}
