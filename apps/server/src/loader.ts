/**
 * Loads code-driven tools and workflows from the assistant directory and reloads them when files change:
 *
 *   assistant/tools/*.ts       default/named exports: pi-durable tools, arrays of tools, or whole extensions
 *   assistant/workflows/*.ts   default/named exports: `defineWorkflow(...)`
 *
 * Each tools file becomes one registry extension named `user:<file>`. Installing an extension with a name already
 * installed replaces it in place, so a reload never disturbs running work: calls in flight finish on the old code.
 */
import { existsSync, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { defineExtension, type Extension, type Registry } from "@earendil-works/pi-durable";
import { isWorkflow } from "@tiny/core/define";
import type { ToolInfo } from "@tiny/core/protocol";
import type { WorkflowCatalog } from "./workflows.ts";

type AnyTool = { name: string; description: string; execute: unknown; parameters: unknown };

function isTool(value: unknown): value is AnyTool {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as AnyTool).name === "string" &&
		typeof (value as AnyTool).execute === "function"
	);
}

function isExtension(value: unknown): value is Extension {
	if (typeof value !== "object" || value === null || isTool(value) || isWorkflow(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.name === "string" &&
		["tools", "sections", "hooks", "wraps", "tasks"].some((key) => Array.isArray(candidate[key]))
	);
}

const SOURCE = /\.(ts|tsx|js|mjs)$/;

export class UserCodeLoader {
	readonly #installed = new Map<string, Extension>();
	readonly #tools = new Map<string, ToolInfo[]>();
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	#watcher: ReturnType<typeof watch> | undefined;

	constructor(
		readonly dir: string,
		readonly registry: Registry,
		readonly workflows: WorkflowCatalog,
		readonly onChange: () => void,
	) {}

	tools(): ToolInfo[] {
		return [...this.#tools.values()].flat().sort((a, b) => a.name.localeCompare(b.name));
	}

	async loadAll(): Promise<void> {
		for (const sub of ["tools", "workflows"] as const) {
			const folder = join(this.dir, sub);
			if (!existsSync(folder)) continue;
			for (const file of (await readdir(folder)).sort()) {
				if (SOURCE.test(file) && !file.startsWith("_") && !file.includes(".test.")) {
					await this.#load(join(folder, file), false);
				}
			}
		}
	}

	watch(): void {
		if (!existsSync(this.dir)) return;
		this.#watcher = watch(this.dir, { recursive: true }, (_event, name) => {
			if (!name || !SOURCE.test(name)) return;
			const path = join(this.dir, name);
			clearTimeout(this.#timers.get(path));
			this.#timers.set(
				path,
				setTimeout(() => {
					this.#timers.delete(path);
					void this.#load(path, true).then(() => this.onChange());
				}, 150),
			);
		});
	}

	close(): void {
		this.#watcher?.close();
		for (const timer of this.#timers.values()) clearTimeout(timer);
	}

	async #load(path: string, reload: boolean): Promise<void> {
		const source = relative(this.dir, path);
		const kind = source.startsWith("workflows") ? "workflows" : source.startsWith("tools") ? "tools" : undefined;
		if (!kind || basename(path).startsWith("_")) return;
		const extensionName = `user:${source.replace(SOURCE, "")}`;

		if (!existsSync(path)) {
			this.#unload(source, extensionName);
			console.log(`[assistant] removed ${source}`);
			return;
		}

		let module: Record<string, unknown>;
		try {
			// A query string makes Bun evaluate the file again instead of returning the cached module.
			module = (await import(`${path}?v=${reload ? Date.now() : 0}`)) as Record<string, unknown>;
		} catch (error) {
			console.error(`[assistant] failed to load ${source}: ${error instanceof Error ? error.message : error}`);
			return;
		}
		const exported = Object.values(module).flatMap((value) => (Array.isArray(value) ? value : [value]));

		if (kind === "workflows") {
			this.workflows.removeSource(source);
			const found = exported.filter(isWorkflow);
			for (const workflow of found) this.workflows.set(workflow, source);
			console.log(
				`[assistant] ${reload ? "reloaded" : "loaded"} ${source}: ${found.map((w) => w.name).join(", ") || "no workflows"}`,
			);
			return;
		}

		const extensions = exported.filter(isExtension);
		const tools = exported.filter(isTool);
		const extension =
			extensions.length === 1 && tools.length === 0
				? extensions[0]!
				: defineExtension({
						name: extensionName,
						tools: [...tools, ...extensions.flatMap((ext) => (ext.tools ?? []) as AnyTool[])] as never,
						sections: extensions.flatMap((ext) => ext.sections ?? []),
						hooks: extensions.flatMap((ext) => ext.hooks ?? []),
					});
		const previous = this.#installed.get(source);
		if (previous && previous.name !== extension.name) this.registry.uninstall(previous);
		this.registry.install(extension);
		this.#installed.set(source, extension);
		const toolList = ((extension.tools ?? []) as AnyTool[]).map((tool) => ({
			name: tool.name,
			description: tool.description,
			source,
		}));
		this.#tools.set(source, toolList);
		console.log(
			`[assistant] ${reload ? "reloaded" : "loaded"} ${source}: ${toolList.map((t) => t.name).join(", ") || "no tools"}`,
		);
	}

	#unload(source: string, _extensionName: string): void {
		this.workflows.removeSource(source);
		const previous = this.#installed.get(source);
		if (previous) this.registry.uninstall(previous);
		this.#installed.delete(source);
		this.#tools.delete(source);
	}
}
