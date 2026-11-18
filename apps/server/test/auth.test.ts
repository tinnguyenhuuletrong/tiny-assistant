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
	});
});
