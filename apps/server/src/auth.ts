/**
 * Who may talk to the daemon. It is meant to sit on a home machine reachable over Tailscale:
 *
 * - Network: loopback and tailnet addresses (100.64.0.0/10, fd7a:115c:a1e0::/48) only, unless
 *   `TINY_ALLOW_ANY_NETWORK=1`. `tailscale serve` proxies from loopback, so it passes.
 * - Host: the `Host` header must name this machine (an IP, localhost, a single-label or `.local` name, a `*.ts.net`
 *   name, or `TINY_ALLOWED_HOSTS`), which defeats DNS rebinding.
 * - Origin: requests that change something, and WebSocket upgrades, must come from the daemon's own origin (or
 *   `TINY_ALLOWED_ORIGINS`) when a browser sends them. Without this, any web page could drive the agent through
 *   127.0.0.1. Non-browser clients (the TUI, curl) send no Origin.
 * - Identity: behind `tailscale serve`, requests carry `Tailscale-User-Login`. It is trusted only on connections from
 *   loopback (where `tailscale serve` connects from); `TINY_ALLOWED_LOGINS` restricts it.
 * - Token: with `TINY_TOKEN` set, every request must carry it (Bearer header, `?token=`, or the `tiny_token` cookie),
 *   except an allowed Tailscale login.
 */
import type { Config } from "./config.ts";

function ipv4ToInt(ip: string): number | undefined {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
	return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isLoopback(address: string | undefined): boolean {
	if (!address) return false;
	const ip = address.replace(/^::ffff:/, "");
	return ip === "::1" || ip.startsWith("127.");
}

export function isTrustedAddress(address: string | undefined): boolean {
	if (!address) return false;
	if (isLoopback(address)) return true;
	const ip = address.replace(/^::ffff:/, "");
	const v4 = ipv4ToInt(ip);
	if (v4 !== undefined) {
		// 100.64.0.0/10: Tailscale's CGNAT range.
		return v4 >>> 22 === ipv4ToInt("100.64.0.0")! >>> 22;
	}
	return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

/** The hostname of a `Host` header or URL authority, lowercased, without port or IPv6 brackets. */
function hostnameOf(authority: string): string {
	const value = authority.trim().toLowerCase();
	if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
	const colons = value.split(":").length - 1;
	return colons === 1 ? value.slice(0, value.indexOf(":")) : value;
}

/**
 * Whether a `Host` header names this machine. DNS rebinding needs an attacker-controlled domain name, so IP literals,
 * single-label names (MagicDNS short names), `localhost`, `.local`, and `.ts.net` are safe; anything else must be
 * listed in `TINY_ALLOWED_HOSTS`.
 */
export function isAllowedHost(config: Config, host: string | null): boolean {
	if (!host) return true;
	const name = hostnameOf(host);
	if (config.allowedHosts.includes(name)) return true;
	if (name === "localhost" || name.endsWith(".localhost")) return true;
	if (ipv4ToInt(name) !== undefined || name.includes(":")) return true;
	if (!name.includes(".")) return true;
	return name.endsWith(".ts.net") || name.endsWith(".local");
}

/** Whether a browser `Origin` may make state-changing requests: the daemon's own origin, a tailnet name, or listed. */
export function isAllowedOrigin(config: Config, origin: string, host: string | null): boolean {
	if (config.allowedOrigins.includes(origin)) return true;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false; // includes "null" (sandboxed iframes, file://)
	}
	if (host && url.host.toLowerCase() === host.trim().toLowerCase()) return true;
	return url.protocol === "https:" && url.hostname.toLowerCase().endsWith(".ts.net");
}

function tokenOf(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	if (header?.startsWith("Bearer ")) return header.slice(7);
	const url = new URL(request.url);
	const query = url.searchParams.get("token");
	if (query) return query;
	const cookie = request.headers.get("cookie");
	return cookie?.match(/(?:^|;\s*)tiny_token=([^;]+)/)?.[1];
}

export type AuthResult = { ok: true; login: string | undefined } | { ok: false; status: number; reason: string };

export function authorize(config: Config, request: Request, address: string | undefined): AuthResult {
	if (!config.allowAnyNetwork && !isTrustedAddress(address)) {
		return { ok: false, status: 403, reason: "Only loopback and tailnet clients may connect" };
	}
	const host = request.headers.get("host");
	if (!isAllowedHost(config, host)) {
		return {
			ok: false,
			status: 403,
			reason: `Unexpected Host "${host}". Add it to TINY_ALLOWED_HOSTS if it is yours.`,
		};
	}
	const origin = request.headers.get("origin");
	const changes = !["GET", "HEAD", "OPTIONS"].includes(request.method);
	const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
	if ((changes || upgrade) && origin !== null && !isAllowedOrigin(config, origin, host)) {
		return { ok: false, status: 403, reason: `Cross-origin request from ${origin} refused` };
	}
	// Only `tailscale serve` (connecting from loopback) can vouch for a Tailscale identity.
	const login = isLoopback(address) ? (request.headers.get("tailscale-user-login") ?? undefined) : undefined;
	if (login && config.allowedLogins.length > 0 && !config.allowedLogins.includes(login)) {
		return { ok: false, status: 403, reason: `Tailscale user ${login} is not allowed` };
	}
	if (config.token) {
		const loginAllowed = login !== undefined && config.allowedLogins.includes(login);
		if (!loginAllowed && tokenOf(request) !== config.token) {
			return { ok: false, status: 401, reason: "Missing or wrong token" };
		}
	}
	return { ok: true, login };
}
