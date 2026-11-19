/**
 * Getting files into the TUI: the clipboard (an image copied anywhere, or files copied in Finder) and paths (dragged
 * into the terminal, or typed after /attach). Files are read here and uploaded to the daemon, so this works against a
 * daemon on another machine too.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export type LocalFile = { name: string; type: string; bytes: Uint8Array };

function run(command: string[]): { ok: boolean; stdout: Uint8Array; text: string } {
	try {
		const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" });
		const stdout = result.stdout ?? new Uint8Array();
		return { ok: result.exitCode === 0, stdout, text: new TextDecoder().decode(stdout).trim() };
	} catch {
		return { ok: false, stdout: new Uint8Array(), text: "" };
	}
}

/** A file on disk, read for upload. */
export function readLocalFile(path: string): LocalFile {
	const bytes = readFileSync(path);
	return { name: basename(path), type: Bun.file(path).type.split(";")[0] || "application/octet-stream", bytes };
}

/**
 * What the clipboard holds as files: files copied in Finder, else an image (a screenshot, an image copied in a
 * browser). Empty when it holds only text, or the platform's clipboard tools are missing.
 */
export function readClipboardFiles(): LocalFile[] {
	if (process.platform === "darwin") return macClipboard();
	if (process.platform === "linux") return linuxClipboard();
	return [];
}

function macClipboard(): LocalFile[] {
	// Files copied in Finder: their paths.
	const paths = run([
		"osascript",
		"-e",
		'try\nset out to ""\nrepeat with f in (the clipboard as «class furl» as list)\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out\non error\nreturn ""\nend try',
	]);
	const files = paths.text
		.split("\n")
		.map((line) => line.trim())
		.filter((path) => path && existsSync(path) && statSync(path).isFile());
	if (files.length > 0) return files.map(readLocalFile);
	// An image: written to a temporary PNG by AppleScript, since the clipboard holds it as PNG data.
	const dir = mkdtempSync(join(tmpdir(), "tiny-paste-"));
	const target = join(dir, "pasted-image.png");
	try {
		const wrote = run([
			"osascript",
			"-e",
			`try\nset d to (the clipboard as «class PNGf»)\nset f to open for access POSIX file "${target}" with write permission\nset eof f to 0\nwrite d to f\nclose access f\nreturn "ok"\non error\nreturn ""\nend try`,
		]);
		if (wrote.text !== "ok" || !existsSync(target)) return [];
		return [{ name: `pasted-image-${stamp()}.png`, type: "image/png", bytes: readFileSync(target) }];
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function linuxClipboard(): LocalFile[] {
	const wayland = Boolean(process.env.WAYLAND_DISPLAY);
	const types = wayland
		? run(["wl-paste", "--list-types"])
		: run(["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"]);
	if (!types.ok) return [];
	const offered = types.text.split("\n").map((line) => line.trim());
	if (offered.includes("text/uri-list")) {
		const list = wayland
			? run(["wl-paste", "--type", "text/uri-list"])
			: run(["xclip", "-selection", "clipboard", "-t", "text/uri-list", "-o"]);
		const files = list.text
			.split(/\r?\n/)
			.filter((line) => line.startsWith("file://"))
			.map((line) => decodeURIComponent(line.slice("file://".length)))
			.filter((path) => existsSync(path) && statSync(path).isFile());
		if (files.length > 0) return files.map(readLocalFile);
	}
	const image = offered.find((type) => /^image\/(png|jpeg|gif|webp)$/.test(type));
	if (!image) return [];
	const data = wayland
		? run(["wl-paste", "--type", image])
		: run(["xclip", "-selection", "clipboard", "-t", image, "-o"]);
	if (!data.ok || data.stdout.length === 0) return [];
	return [{ name: `pasted-image-${stamp()}.${image.split("/")[1]}`, type: image, bytes: data.stdout }];
}

function stamp(): string {
	return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/**
 * Paths in text pasted by dragging files into a terminal: separated by spaces, with spaces escaped (`a\ b.png`) or
 * quoted (`'a b.png'`). Returns them only when every one is an existing file, so ordinary pasted text is left alone.
 */
export function pastedPaths(text: string, cwd = process.cwd()): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	let started = false;
	const trimmed = text.trim();
	for (let index = 0; index < trimmed.length; index++) {
		const char = trimmed[index]!;
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			started = true;
		} else if (char === "\\" && index + 1 < trimmed.length) {
			current += trimmed[++index];
			started = true;
		} else if (/\s/.test(char)) {
			if (started) tokens.push(current);
			current = "";
			started = false;
		} else {
			current += char;
			started = true;
		}
	}
	if (started) tokens.push(current);
	if (tokens.length === 0 || quote) return undefined;
	const paths = tokens.map((token) => {
		const path = token.startsWith("file://") ? decodeURIComponent(token.slice(7)) : token;
		return path.startsWith("~") ? join(homedir(), path.slice(1)) : resolve(cwd, path);
	});
	const looksLikePaths = tokens.every((token) => /^(\/|~|\.{1,2}\/|file:\/\/)/.test(token));
	if (!looksLikePaths) return undefined;
	return paths.every((path) => existsSync(path) && statSync(path).isFile()) ? paths : undefined;
}
