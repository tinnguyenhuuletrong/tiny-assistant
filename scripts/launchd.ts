#!/usr/bin/env bun
/**
 * Run the daemon at login and keep it alive (macOS launchd).
 *
 *   bun scripts/launchd.ts install     write ~/Library/LaunchAgents/dev.tiny-assistant.plist and start it
 *   bun scripts/launchd.ts uninstall   stop it and remove the plist
 *   bun scripts/launchd.ts status
 *
 * Settings come from the repo's `.env` (Bun loads it from the working directory).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const LABEL = "dev.tiny-assistant";
const repo = resolve(import.meta.dir, "..");
const plist = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const logDir = join(homedir(), ".tiny-assistant", "logs");
const domain = `gui/${process.getuid?.() ?? 501}`;

function run(...cmd: string[]): { code: number; out: string } {
	const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
	return { code: result.exitCode, out: `${result.stdout}${result.stderr}`.trim() };
}

function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function install(): void {
	if (process.platform !== "darwin") throw new Error("launchd is macOS only; use systemd or pm2 elsewhere");
	const claude = run("which", "claude").out;
	if (!claude) console.warn("warning: `claude` is not on PATH; the Claude Code provider will not work");
	// launchd starts with a minimal PATH: keep the directories bun, claude, git, and friends live in.
	const path = [
		dirname(process.execPath),
		claude ? dirname(claude) : undefined,
		join(homedir(), ".local/bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	]
		.filter((dir, index, all): dir is string => Boolean(dir) && all.indexOf(dir) === index)
		.join(":");
	mkdirSync(logDir, { recursive: true });
	mkdirSync(dirname(plist), { recursive: true });
	writeFileSync(
		plist,
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(process.execPath)}</string>
		<string>${xml(join(repo, "apps/server/src/main.ts"))}</string>
	</array>
	<key>WorkingDirectory</key><string>${xml(repo)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key><string>${xml(path)}</string>
		<key>HOME</key><string>${xml(homedir())}</string>
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>${xml(join(logDir, "daemon.log"))}</string>
	<key>StandardErrorPath</key><string>${xml(join(logDir, "daemon.log"))}</string>
</dict>
</plist>
`,
	);
	run("launchctl", "bootout", `${domain}/${LABEL}`);
	const loaded = run("launchctl", "bootstrap", domain, plist);
	if (loaded.code !== 0) throw new Error(`launchctl bootstrap failed: ${loaded.out}`);
	console.log(`installed ${plist}\nlogs: ${join(logDir, "daemon.log")}`);
}

function uninstall(): void {
	run("launchctl", "bootout", `${domain}/${LABEL}`);
	if (existsSync(plist)) rmSync(plist);
	console.log("uninstalled");
}

const action = process.argv[2];
if (action === "install") install();
else if (action === "uninstall") uninstall();
else if (action === "status") console.log(run("launchctl", "print", `${domain}/${LABEL}`).out || "not loaded");
else {
	console.error("usage: bun scripts/launchd.ts install|uninstall|status");
	process.exit(1);
}
