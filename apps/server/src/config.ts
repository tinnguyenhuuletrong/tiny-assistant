import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Everything configurable, from the environment (Bun loads `.env` automatically). */
export type Config = {
	host: string;
	port: number;
	/** Where the SQLite database and other state live. */
	dataDir: string;
	/** Code-driven tools and workflows: `<dir>/tools/*.ts`, `<dir>/workflows/*.ts`, optional `<dir>/SYSTEM.md`. */
	assistantDir: string;
	/** Built web app to serve; absent: API only. */
	webDir: string | undefined;
	/** Model providers to enable (pi-ai provider ids); default `claude-code`. */
	providers: string[];
	/** `provider/modelId` for new sessions; absent: the first available model. */
	defaultModel: string | undefined;
	/** Folders the project picker may browse. */
	fsRoots: string[];
	/** Optional shared secret. When set, clients must send it (Bearer header or `?token=`). */
	token: string | undefined;
	/** Tailscale logins allowed through `tailscale serve` (the `Tailscale-User-Login` header); empty: any tailnet user. */
	allowedLogins: string[];
	/** Accept connections from outside loopback and the tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48). Off by default. */
	allowAnyNetwork: boolean;
};

const repoRoot = resolve(import.meta.dir, "../../..");

function expand(path: string): string {
	return path.startsWith("~") ? join(homedir(), path.slice(1)) : resolve(path);
}

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
	const webDir = env.TINY_WEB_DIR ? expand(env.TINY_WEB_DIR) : join(repoRoot, "apps/web/dist");
	return {
		host: env.TINY_HOST ?? "127.0.0.1",
		port: Number(env.TINY_PORT ?? env.PORT ?? 7777),
		dataDir: expand(env.TINY_DATA_DIR ?? "~/.tiny-assistant"),
		assistantDir: expand(env.TINY_ASSISTANT_DIR ?? join(repoRoot, "assistant")),
		webDir,
		providers: list(env.TINY_PROVIDERS ?? "claude-code"),
		defaultModel: env.TINY_DEFAULT_MODEL || undefined,
		fsRoots: (list(env.TINY_FS_ROOTS).length > 0 ? list(env.TINY_FS_ROOTS) : ["~"]).map(expand),
		token: env.TINY_TOKEN || undefined,
		allowedLogins: list(env.TINY_ALLOWED_LOGINS),
		allowAnyNetwork: env.TINY_ALLOW_ANY_NETWORK === "1",
	};
}
