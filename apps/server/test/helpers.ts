import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Config } from "../src/config.ts";
import type { Engine } from "../src/engines/types.ts";
import { AssistantService } from "../src/service.ts";

export type Fixture = {
	root: string;
	config: Config;
	faux: FauxProviderHandle;
	/** `engines` replaces the configured engines (none by default, so tests never start a real CLI). */
	open(options?: { engines?: Engine[] }): Promise<AssistantService>;
	cleanup(): void;
};

/** A temp data dir, assistant dir, and project folder, with a scripted model instead of a real provider. */
export function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "tiny-test-"));
	for (const dir of ["data", "assistant/tools", "assistant/workflows", "project"])
		mkdirSync(join(root, dir), { recursive: true });
	const config: Config = {
		host: "127.0.0.1",
		port: 0,
		dataDir: join(root, "data"),
		assistantDir: join(root, "assistant"),
		webDir: undefined,
		providers: [],
		defaultModel: undefined,
		engines: [],
		claude: { command: "claude", permissionMode: "bypassPermissions", chrome: undefined, useApiKey: false },
		fsRoots: [root],
		token: undefined,
		allowedLogins: [],
		allowedHosts: [],
		allowedOrigins: [],
		allowAnyNetwork: false,
	};
	const faux = fauxProvider();
	return {
		root,
		config,
		faux,
		async open(options = {}) {
			const models = createModels();
			models.setProvider(faux.provider);
			return AssistantService.open(config, { models, engines: options.engines ?? [] });
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export async function until<T>(
	what: string,
	check: () => T | undefined | false | Promise<T | undefined | false>,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for ${what}`);
}
