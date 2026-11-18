import { describe, expect, test } from "bun:test";
import { authorize, isTrustedAddress } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";

describe("auth", () => {
	test("trusts loopback and the tailnet only", () => {
		expect(isTrustedAddress("127.0.0.1")).toBe(true);
		expect(isTrustedAddress("::1")).toBe(true);
		expect(isTrustedAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isTrustedAddress("100.101.102.103")).toBe(true);
		expect(isTrustedAddress("100.128.0.1")).toBe(false);
		expect(isTrustedAddress("192.168.1.10")).toBe(false);
		expect(isTrustedAddress("fd7a:115c:a1e0::1")).toBe(true);
	});

	test("token and Tailscale identity", () => {
		const config = { ...loadConfig({}), token: "secret", allowedLogins: ["me@example.com"] };
		const request = (headers: Record<string, string> = {}, url = "http://x/api/state") => new Request(url, { headers });
		expect(authorize(config, request(), "127.0.0.1")).toMatchObject({ ok: false, status: 401 });
		expect(authorize(config, request({ authorization: "Bearer secret" }), "127.0.0.1").ok).toBe(true);
		expect(authorize(config, request({}, "http://x/ws?token=secret"), "100.64.0.9").ok).toBe(true);
		expect(authorize(config, request({ "tailscale-user-login": "me@example.com" }), "127.0.0.1").ok).toBe(true);
		expect(authorize(config, request({ "tailscale-user-login": "other@example.com" }), "127.0.0.1")).toMatchObject({
			ok: false,
			status: 403,
		});
		expect(authorize(config, request({ authorization: "Bearer secret" }), "8.8.8.8")).toMatchObject({ ok: false });
		// The Tailscale header only counts from loopback (tailscale serve); a tailnet peer cannot forge it.
		expect(authorize(config, request({ "tailscale-user-login": "me@example.com" }), "100.64.0.9")).toMatchObject({
			ok: false,
			status: 401,
		});
	});

	test("browser requests from other sites cannot drive the daemon", () => {
		const config = loadConfig({});
		const post = (headers: Record<string, string>) =>
			new Request("http://127.0.0.1:7777/api/sessions", {
				method: "POST",
				headers: { host: "127.0.0.1:7777", ...headers },
			});
		expect(authorize(config, post({ origin: "https://evil.example" }), "127.0.0.1")).toMatchObject({
			ok: false,
			status: 403,
		});
		expect(authorize(config, post({ origin: "null" }), "127.0.0.1")).toMatchObject({ ok: false });
		expect(authorize(config, post({ origin: "http://127.0.0.1:7777" }), "127.0.0.1").ok).toBe(true); // the web app
		expect(authorize(config, post({ origin: "http://localhost:5173" }), "127.0.0.1").ok).toBe(true); // vite dev
		expect(authorize(config, post({}), "127.0.0.1").ok).toBe(true); // TUI, curl: no Origin
		const ws = new Request("http://127.0.0.1:7777/ws", {
			headers: { host: "127.0.0.1:7777", upgrade: "websocket", origin: "https://evil.example" },
		});
		expect(authorize(config, ws, "127.0.0.1")).toMatchObject({ ok: false, status: 403 });
		// Reading is fine cross-origin (the browser withholds the response), but not through a rebound DNS name.
		const rebound = new Request("http://evil.example:7777/api/state", { headers: { host: "evil.example:7777" } });
		expect(authorize(config, rebound, "127.0.0.1")).toMatchObject({ ok: false, status: 403 });
		for (const host of [
			"127.0.0.1:7777",
			"localhost:7777",
			"mac-mini:7777",
			"mac-mini.tail1234.ts.net",
			"[::1]:7777",
		]) {
			const get = new Request(`http://${host}/api/state`, { headers: { host } });
			expect(authorize(config, get, "127.0.0.1").ok).toBe(true);
		}
	});
});
