/**
 * The authoring API for code-driven tools and workflows. Files under `assistant/tools/` and `assistant/workflows/`
 * import from `@tiny/core/define`; the daemon discovers them, installs them into the pi-durable registry, and reloads
 * them when they change.
 *
 * Tools are plain pi-durable tools (`defineTool`), so they get durable execution, streaming output, and replay rules
 * for free. Workflows are durable tasks: every `step()` result is checkpointed, so a workflow interrupted by a crash or
 * restart resumes after its last finished step.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import type { Schema, Static } from "@earendil-works/pi-schema";

export type { JsonValue } from "@earendil-works/chord/json";
export {
	defineExtension,
	defineTool,
	hook,
	section,
	ToolTask,
	wrapTool,
} from "@earendil-works/pi-durable";
export { arr, bool, int, lit, num, obj, oneOf, opt, str, union, unknown } from "@earendil-works/pi-schema";

export type ExecResult = { exitCode: number; output: string };

export type WorkflowContext<I> = {
	readonly input: I;
	/** The session the workflow runs in; its transcript shows the steps, logs, and agent turns. */
	readonly sessionId: number;
	/** The session's working directory (its project folder), when it has one. */
	readonly cwd: string | undefined;
	/** Aborted when the run is stopped. */
	readonly signal: AbortSignal;
	/**
	 * Run `fn` once. Its JSON result is checkpointed under `name`; after a restart the stored value is returned instead
	 * of running `fn` again. Names must be unique within one run.
	 */
	step<T extends JsonValue>(name: string, fn: () => Promise<T> | T): Promise<T>;
	/**
	 * Ask the agent, in this session, and return its final answer text. The turn is a normal durable run: it streams in
	 * every client and may use tools. Checkpointed like a step (named by `options.step`, default `agent:<n>`).
	 */
	agent(prompt: string, options?: { step?: string }): Promise<string>;
	/** Run a shell command in the session's directory. Checkpointed like a step (default name `exec:<n>`). */
	exec(command: string, options?: { step?: string; cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
	/** Append a log line to the session transcript. */
	log(text: string, level?: "info" | "warn" | "error"): Promise<void>;
};

export type WorkflowDefinition<I = unknown> = {
	readonly kind: "tiny.workflow";
	readonly name: string;
	readonly description: string;
	/** JSON Schema of the input (pi-schema builders), shown as a form in clients and validated before a run starts. */
	readonly input?: Schema<I>;
	run(ctx: WorkflowContext<I>): Promise<unknown>;
};

export function defineWorkflow<S extends Schema<unknown>>(definition: {
	name: string;
	description: string;
	input: S;
	run(ctx: WorkflowContext<Static<S>>): Promise<unknown>;
}): WorkflowDefinition<Static<S>>;
export function defineWorkflow(definition: {
	name: string;
	description: string;
	run(ctx: WorkflowContext<undefined>): Promise<unknown>;
}): WorkflowDefinition<undefined>;
export function defineWorkflow(definition: {
	name: string;
	description: string;
	input?: Schema<unknown>;
	run(ctx: WorkflowContext<unknown>): Promise<unknown>;
}): WorkflowDefinition<unknown> {
	if (!/^[a-z0-9][a-z0-9_-]*$/i.test(definition.name)) {
		throw new Error(`Workflow name "${definition.name}" must be letters, digits, '-' or '_'`);
	}
	return { kind: "tiny.workflow", ...definition };
}

export function isWorkflow(value: unknown): value is WorkflowDefinition<unknown> {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "tiny.workflow";
}
