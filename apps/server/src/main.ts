#!/usr/bin/env bun
/**
 * tiny-assistant daemon: one process owns the durable harness and the database; the web app and TUI clients connect
 * to it over HTTP + WebSocket.
 */
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";
import { AssistantService } from "./service.ts";

const config = loadConfig();
const service = await AssistantService.open(config);
const server = startServer(service);

console.log(`[tiny] listening on http://${server.hostname}:${server.port}`);
console.log(`[tiny] data: ${config.dataDir}`);
console.log(`[tiny] assistant code: ${config.assistantDir}`);
if (config.host === "127.0.0.1") {
	console.log("[tiny] loopback only. For your tailnet: `make tailscale-serve` (HTTPS) or TINY_HOST=0.0.0.0");
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
	if (stopping) process.exit(1);
	stopping = true;
	console.log(`[tiny] ${signal}: shutting down`);
	server.stop(true);
	// Work in flight stays pending in storage and resumes on the next start.
	await Promise.race([service.close(), Bun.sleep(5000)]);
	process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
