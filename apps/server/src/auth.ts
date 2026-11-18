/**
 * Who may talk to the daemon. It is meant to sit on a home machine reachable over Tailscale:
 *
 * - Network: loopback and tailnet addresses (100.64.0.0/10, fd7a:115c:a1e0::/48) only, unless
 *   `TINY_ALLOW_ANY_NETWORK=1`. `tailscale serve` proxies from loopback, so it passes.
 * - Identity: behind `tailscale serve`, requests carry `Tailscale-User-Login`; `TINY_ALLOWED_LOGINS` restricts it.
 * - Token: with `TINY_TOKEN` set, every request must carry it (Bearer header, `?token=`, or the `tiny_token` cookie),
 *   except an allowed Tailscale login.
 */
import type { Config } from "./config.ts";

function ipv4ToInt(ip: string): number | undefined {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
	return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function isTrustedAddress(address: string | undefined): boolean {
	if (!address) return false;
	const ip = address.replace(/^::ffff:/, "");
	if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.")) return true;
	const v4 = ipv4ToInt(ip);
	if (v4 !== undefined) {
		// 100.64.0.0/10: Tailscale's CGNAT range.
		return v4 >>> 22 === ipv4ToInt("100.64.0.0")! >>> 22;
	}
	return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
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
	const login = request.headers.get("tailscale-user-login") ?? undefined;
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
