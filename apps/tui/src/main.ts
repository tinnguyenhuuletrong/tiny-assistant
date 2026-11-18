#!/usr/bin/env bun
/**
 * tiny TUI: a terminal client for the tiny-assistant daemon. Same API, same live state as the web app.
 *
 *   bun apps/tui/src/main.ts [http://host:7777] [--token T] [--continue | --session ID] [--project NAME]
 */
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	Markdown,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	type SelectItem,
	SelectList,
	type SlashCommand,
	Text,
	TuiAltScreen,
	truncateToWidth,
	VStack,
} from "@earendil-works/pi-tui";
import {
	AssistantClient,
	type AssistantPart,
	buildDisplay,
	type DisplayItem,
	failureText,
	type ProjectInfo,
	type SessionInfo,
	sessionUsage,
	summarizeLive,
	type ThinkingLevel,
	type ToolState,
	toolSummary,
	type WorkflowRun,
	type WorkflowStepStatus,
} from "@tiny/core";
import { c, editorTheme, markdownTheme, selectListTheme } from "./theme.ts";

// ---- arguments ----

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const value = args[index + 1];
	args.splice(index, 2);
	return value;
}
function bool(...names: string[]): boolean {
	const index = args.findIndex((arg) => names.includes(arg));
	if (index < 0) return false;
	args.splice(index, 1);
	return true;
}
if (bool("-h", "--help")) {
	console.log(`tiny: terminal client for tiny-assistant

Usage: bun apps/tui/src/main.ts [URL] [options]

  URL               daemon address (default $TINY_URL or http://127.0.0.1:7777)
  --token T         access token (default $TINY_TOKEN)
  -c, --continue    open the most recent session
  --session ID      open a session
  --project NAME    start new chats in this project`);
	process.exit(0);
}
const token = flag("--token") ?? process.env.TINY_TOKEN;
const sessionArg = flag("--session");
const projectArg = flag("--project");
const continueLast = bool("-c", "--continue");
const baseUrl = (args[0] ?? process.env.TINY_URL ?? "http://127.0.0.1:7777").replace(/\/$/, "");

// ---- client ----

const client = new AssistantClient({ baseUrl, token, client: "tui", name: process.env.USER });
try {
	await client.loadState();
} catch (error) {
	console.error(
		`Cannot reach the tiny-assistant daemon at ${baseUrl}: ${error instanceof Error ? error.message : error}`,
	);
	console.error("Start it with `make start` (or `bun run start`), or pass its address: bun tui http://host:7777");
	process.exit(1);
}
client.connect();

type UiState = {
	sessionId: number | null;
	/** Project for the next new chat. */
	draftProject: string | null;
	draftModel: string | null;
	draftThinking: ThinkingLevel;
	expanded: boolean;
	notice: { text: string; level: "info" | "error" } | null;
	spinner: number;
};

const ui: UiState = {
	sessionId: null,
	draftProject: null,
	draftModel: null,
	draftThinking: "medium",
	expanded: false,
	notice: null,
	spinner: 0,
};

function sessions(): SessionInfo[] {
	return client.state?.sessions ?? [];
}
function projects(): ProjectInfo[] {
	return client.state?.projects ?? [];
}
function current(): SessionInfo | undefined {
	return sessions().find((session) => session.id === ui.sessionId);
}
function projectName(id: string | null | undefined): string | null {
	return id ? (projects().find((project) => project.id === id)?.name ?? null) : null;
}

{
	const cwdProject = projects().find((project) => project.path === process.cwd());
	const named = projectArg ? projects().find((project) => project.name === projectArg) : undefined;
	ui.draftProject = named?.id ?? cwdProject?.id ?? null;
	if (sessionArg) ui.sessionId = Number(sessionArg);
	else if (continueLast) ui.sessionId = sessions()[0]?.id ?? null;
}

// ---- rendering ----

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function indent(lines: string[], prefix: string, rest = "  "): string {
	return lines.map((line, index) => (index === 0 ? prefix : rest) + line).join("\n");
}

function toolText(tool: ToolState, expanded: boolean): string {
	const icon =
		tool.status === "done"
			? c.green("⏺")
			: tool.status === "error"
				? c.red("⏺")
				: tool.status === "parked"
					? c.yellow("⏸")
					: c.yellow(SPINNER[ui.spinner % SPINNER.length]!);
	const summary = toolSummary(tool);
	const head = `${icon} ${c.bold(tool.name)}${summary ? c.dim(`(${summary})`) : ""}`;
	const output = tool.output.replace(/\s+$/, "");
	if (!output) return head;
	const lines = output.split("\n");
	const limit = expanded ? 400 : tool.status === "running" ? 6 : 3;
	const shown = tool.status === "running" ? lines.slice(-limit) : lines.slice(0, limit);
	const more = lines.length > shown.length ? c.dim(`  … ${lines.length - shown.length} more lines (ctrl+o)`) : "";
	const body = indent(
		shown.map((line) => c.dim(line.slice(0, 400))),
		"  ⎿ ",
		"    ",
	);
	return `${head}\n${body}${more ? `\n${more}` : ""}`;
}

function workflowRunText(run: WorkflowRun, expanded: boolean): string {
	const spin = SPINNER[ui.spinner % SPINNER.length]!;
	const phase: Record<WorkflowRun["phase"], string> = {
		running: c.accent(`${spin} running`),
		rolling_back: c.yellow(`${spin} rolling back`),
		completed: c.green("✓ completed"),
		failed: c.red("✗ failed"),
		aborted: c.yellow("■ stopped"),
	};
	const lines = [`${c.accent("⚙")} ${c.bold(run.name)} ${c.dim(`run ${run.runId}`)}  ${phase[run.phase]}`];
	const icon = (status: WorkflowStepStatus): string =>
		({
			running: c.accent(spin),
			done: c.green("✓"),
			failed: c.red("✗"),
			undoing: c.yellow(spin),
			undone: c.yellow("↺"),
			undo_failed: c.red("✗"),
		})[status];
	run.steps.forEach((step, index) => {
		const last = index === run.steps.length - 1;
		const struck = step.status === "undone" ? c.strike(c.dim(step.name)) : step.name;
		const note = step.summary
			? c.dim(` ${step.summary}`)
			: step.status === "undone" || step.status === "undoing"
				? c.dim(` ${step.status}`)
				: "";
		lines.push(`  ${c.dim(last ? "└─" : "├─")} ${icon(step.status)} ${struck}${note}`);
	});
	if (run.rollbackReason)
		lines.push(`  ${c.yellow("↩ undo")} ${c.dim(`finished steps, newest first (${run.rollbackReason})`)}`);
	const logs = expanded ? run.logs : run.logs.slice(-3);
	for (const log of logs) {
		const text = log.text.split("\n")[0]!.slice(0, 200);
		lines.push(
			`  ${c.dim("│")} ${log.level === "error" ? c.red(text) : log.level === "warn" ? c.yellow(text) : c.dim(text)}`,
		);
	}
	if (run.error) lines.push(`  ${c.red(run.error)}`);
	if (run.phase === "completed" && typeof run.result === "string") lines.push(`  ${run.result.split("\n")[0]}`);
	return lines.join("\n");
}

/** One display item as pi-tui components, cached by key and rebuilt only when its content changes. */
class ItemView {
	signature = "";
	readonly container = new Container();
	readonly markdowns: Markdown[] = [];

	update(item: DisplayItem, expanded: boolean): void {
		const running =
			(item.type === "assistant" &&
				item.parts.some(
					(part) => part.type === "tool" && (part.tool.status === "running" || part.tool.status === "pending"),
				)) ||
			(item.type === "workflow-run" && (item.run.phase === "running" || item.run.phase === "rolling_back"));
		const signature = `${expanded}:${running ? ui.spinner : ""}:${JSON.stringify(item)}`;
		if (signature === this.signature) return;
		this.signature = signature;
		this.container.clear();
		let markdownIndex = 0;
		const markdown = (text: string): Markdown => {
			let component = this.markdowns[markdownIndex];
			if (!component) {
				component = new Markdown(text, 1, 0, markdownTheme);
				this.markdowns[markdownIndex] = component;
			} else component.setText(text);
			markdownIndex++;
			return component;
		};
		switch (item.type) {
			case "user": {
				const text = item.text + (item.images.length > 0 ? c.dim(` [${item.images.length} image(s)]`) : "");
				this.container.addChild(new Text(indent(text.split("\n"), c.accent("› ")), 0, 1));
				break;
			}
			case "assistant": {
				for (const part of item.parts) this.#part(part, expanded, markdown);
				if (item.streaming && item.parts.length === 0) this.container.addChild(new Text(c.dim("…"), 1, 0));
				if (item.error) this.container.addChild(new Text(c.red(`✗ ${item.error}`), 1, 0));
				if (expanded && item.usage) {
					const usage = item.usage;
					this.container.addChild(
						new Text(
							c.dim(
								`${item.model ?? ""} · in ${usage.input + usage.cacheRead + usage.cacheWrite} · out ${usage.output}${usage.cost ? ` · $${usage.cost.toFixed(4)}` : ""}`,
							),
							1,
							0,
						),
					);
				}
				this.container.addChild(new Text("", 0, 0));
				break;
			}
			case "compaction":
				this.container.addChild(
					new Text(c.dim(`── compacted ──${expanded ? `\n${item.summary}` : " (ctrl+o for summary)"}`), 1, 1),
				);
				break;
			case "reset":
				this.container.addChild(new Text(c.dim("── context reset ──"), 1, 1));
				break;
			case "workflow": {
				const event = item.event;
				const text =
					event.kind === "started"
						? `${c.accent("⚙")} ${c.bold(`workflow ${event.name}`)} ${c.dim(`run ${event.runId}`)}`
						: event.kind === "step"
							? `  ${event.status === "done" ? c.green("✓") : c.red("✗")} ${event.step}${event.summary ? c.dim(` ${event.summary}`) : ""}`
							: event.kind === "log"
								? `  ${c.dim("│")} ${event.level === "error" ? c.red(event.text) : event.level === "warn" ? c.yellow(event.text) : event.text}`
								: `${event.status === "completed" ? c.green("⚙ done") : event.status === "aborted" ? c.yellow("⚙ stopped") : c.red("⚙ failed")} ${c.dim(event.name)}${event.error ? ` ${c.red(event.error)}` : ""}`;
				this.container.addChild(new Text(text, 1, 0));
				break;
			}
			case "workflow-run":
				this.container.addChild(new Text(workflowRunText(item.run, expanded), 1, 1));
				break;
			case "notice":
				this.container.addChild(
					new Text(item.level === "error" ? c.red(`✗ ${item.text}`) : c.yellow(`■ ${item.text}`), 1, 1),
				);
				break;
		}
	}

	#part(part: AssistantPart, expanded: boolean, markdown: (text: string) => Markdown): void {
		if (part.type === "text") this.container.addChild(markdown(part.text));
		else if (part.type === "thinking") {
			const lines = part.redacted ? ["(redacted)"] : part.text.trim().split("\n");
			const shown = expanded ? lines : lines.slice(0, 1);
			const suffix = !expanded && lines.length > 1 ? c.dim(" …") : "";
			this.container.addChild(new Text(c.dim(c.italic(`✻ ${shown.join("\n  ")}`)) + suffix, 1, 0));
		} else this.container.addChild(new Text(toolText(part.tool, expanded), 1, 0));
	}
}

class Transcript extends Container {
	readonly #views = new Map<string, ItemView>();

	sync(items: DisplayItem[], header: string | undefined): void {
		this.clear();
		if (header) this.addChild(new Text(header, 1, 0));
		const keep = new Set<string>();
		for (const item of items) {
			keep.add(item.key);
			let view = this.#views.get(item.key);
			if (!view) {
				view = new ItemView();
				this.#views.set(item.key, view);
			}
			view.update(item, ui.expanded);
			this.addChild(view.container);
		}
		for (const key of this.#views.keys()) if (!keep.has(key)) this.#views.delete(key);
	}

	reset(): void {
		this.#views.clear();
		this.clear();
	}
}

const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal);
const header = new Text("", 1, 0);
const transcript = new Transcript();
const scroll = new ScrollView(transcript, { follow: "end", primary: true });
const status = new Text("", 1, 0);
const editor = new Editor(tui, editorTheme, { paddingX: 1 });
const footer = new Text("", 1, 0);

tui.setLayoutRoot(
	new VStack([
		{ component: header, basis: "auto" },
		{ component: scroll, basis: 0, grow: 1, minSize: 1 },
		{ component: status, basis: "auto" },
		{ component: editor, basis: "auto", shrink: 1, minSize: 1 },
		{ component: footer, basis: "auto" },
	]),
);

function welcome(): string {
	const project = projectName(ui.draftProject);
	return [
		c.bold(c.accent("✻ tiny")) + c.dim(` connected to ${baseUrl}`),
		"",
		project ? `New chat in ${c.bold(project)}` : `New chat ${c.dim("(no project, /project to pick one)")}`,
		c.dim("Type a message, or /help for commands. ctrl+p switches sessions."),
		"",
	].join("\n");
}

function render(): void {
	const session = current();
	const state = client.state;
	const model = session?.model ?? ui.draftModel ?? state?.defaults.model ?? "no model";
	const project = projectName(session ? session.projectId : ui.draftProject);
	const title = session ? session.title : "New chat";
	const conn = client.status === "open" ? c.green("●") : client.status === "connecting" ? c.yellow("●") : c.red("●");
	header.setText(
		truncateToWidth(
			`${conn} ${c.bold(title)}${project ? c.dim(` · ${project}`) : ""}${c.dim(` · ${model.replace(/^claude-code\//, "")}`)}`,
			Math.max(20, (process.stdout.columns ?? 80) - 2),
		),
	);

	const view = ui.sessionId !== null ? client.views.get(ui.sessionId) : undefined;
	if (ui.sessionId === null) transcript.sync([], welcome());
	else if (!view) transcript.sync([], c.dim("loading…"));
	else {
		const items = buildDisplay(client.entries(ui.sessionId), view.value.docs);
		transcript.sync(items, view.hasEarlier ? c.dim("↑ earlier messages: /earlier") : undefined);
	}

	const live = view ? summarizeLive(view.value.docs) : undefined;
	const workflowBusy = Boolean(session?.workflowRunning) && !live?.busy;
	if (ui.notice) {
		status.setText(ui.notice.level === "error" ? c.red(ui.notice.text) : c.cyan(ui.notice.text));
	} else if (live?.busy || workflowBusy) {
		const spin = c.accent(SPINNER[ui.spinner % SPINNER.length]!);
		const what = live?.retry
			? `retrying: ${live.retry.error.slice(0, 60)}`
			: live?.compacting
				? "compacting…"
				: workflowBusy
					? "workflow running…"
					: live?.generating
						? "thinking…"
						: "running tools…";
		const queued = live?.queued ? c.dim(` · ${live.queued} queued`) : "";
		status.setText(`${spin} ${what}${queued} ${c.dim("· esc to stop · messages queue as follow-ups")}`);
	} else if (live?.failure) {
		status.setText(c.dim(`last run: ${failureText(live.failure.reason, live.failure.detail)} · /continue to resume`));
	} else status.setText("");

	const usage = view ? sessionUsage(view.value.docs) : undefined;
	const cost = usage && usage.cost > 0 ? ` · $${usage.cost.toFixed(3)}` : "";
	footer.setText(c.dim(`/ commands · ctrl+p sessions · ctrl+n new · ctrl+o expand · ctrl+c quit${cost}`));
	tui.requestRender();
}

client.subscribe(render);
client.onError((message) => notify(message, "error"));

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function notify(text: string, level: "info" | "error" = "info"): void {
	ui.notice = { text, level };
	clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => {
		ui.notice = null;
		render();
	}, 4000);
	render();
}

setInterval(() => {
	const session = current();
	const view = ui.sessionId !== null ? client.views.get(ui.sessionId) : undefined;
	if (session?.busy || (view && summarizeLive(view.value.docs).busy)) {
		ui.spinner++;
		render();
	}
}, 100);

// ---- actions ----

function openSession(id: number | null): void {
	if (ui.sessionId !== null && ui.sessionId !== id) client.unfollow(ui.sessionId);
	ui.sessionId = id;
	transcript.reset();
	if (id !== null) client.follow(id);
	scroll.scrollToEnd();
	render();
}

function newChat(projectId?: string | null): void {
	if (projectId !== undefined) ui.draftProject = projectId;
	else if (current()) ui.draftProject = current()!.projectId;
	openSession(null);
}

async function submit(text: string): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed) return;
	if (trimmed.startsWith("/")) {
		await command(trimmed);
		return;
	}
	if (ui.sessionId === null) {
		const session = await client.createSession({
			projectId: ui.draftProject,
			text: trimmed,
			...(ui.draftModel ? { model: ui.draftModel } : {}),
			thinking: ui.draftThinking,
		});
		openSession(session.id);
		return;
	}
	void client.send(ui.sessionId, trimmed, current()?.busy && steerNext ? "steer" : "followUp");
	steerNext = false;
}

let steerNext = false;

function pick(items: SelectItem[], onSelect: (item: SelectItem) => void | Promise<void>, title?: string): void {
	if (items.length === 0) {
		notify("Nothing to pick from");
		return;
	}
	const list = new SelectList(items, Math.min(14, items.length), selectListTheme);
	const box = new Container();
	if (title) box.addChild(new Text(c.bold(title), 1, 0));
	box.addChild(list);
	const handle = tui.showOverlay(
		Object.assign(box, {
			handleInput: (data: string) => list.handleInput(data),
		}) as Component,
		{ width: "80%", maxHeight: "70%", anchor: "center" },
	);
	list.onSelect = (item) => {
		handle.hide();
		tui.setFocus(editor);
		void Promise.resolve()
			.then(() => onSelect(item))
			.catch((error) => notify(error instanceof Error ? error.message : String(error), "error"));
	};
	list.onCancel = () => {
		handle.hide();
		tui.setFocus(editor);
	};
}

function pickSession(): void {
	const items = sessions().map((session) => ({
		value: String(session.id),
		label: `${session.busy ? "● " : ""}${session.pinned ? "★ " : ""}${session.title}`,
		description: [projectName(session.projectId), new Date(session.updatedAt).toLocaleString()]
			.filter(Boolean)
			.join(" · "),
	}));
	pick(items, (item) => openSession(Number(item.value)), "Sessions");
}

function pickProject(then: (project: ProjectInfo | null) => void): void {
	const items: SelectItem[] = [
		{ value: "", label: "No project", description: "plain chat" },
		...projects().map((project) => ({ value: project.id, label: project.name, description: project.path })),
	];
	pick(items, (item) => then(projects().find((project) => project.id === item.value) ?? null), "Projects");
}

async function command(line: string): Promise<void> {
	const [name, ...rest] = line.slice(1).split(" ");
	const arg = rest.join(" ").trim();
	const id = ui.sessionId;
	const needSession = (): number => {
		if (id === null) throw new Error("No session open");
		return id;
	};
	switch (name) {
		case "help":
			notify(
				"/new /sessions /project [path] /model /thinking <lvl> /run <wf> [json] /rename /archive /pin /compact /reset /continue /steer /earlier /quit",
			);
			return;
		case "new":
			if (arg) {
				const project = projects().find((p) => p.name === arg);
				newChat(project?.id ?? null);
			} else newChat();
			return;
		case "sessions":
		case "s":
			pickSession();
			return;
		case "project":
			if (arg) {
				const path = arg.startsWith("/") || arg.startsWith("~") ? arg : `${process.cwd()}/${arg === "." ? "" : arg}`;
				const project = await client.createProject({ path });
				notify(`Project ${project.name} ready`);
				if (id !== null) await client.updateSession(id, { projectId: project.id });
				else ui.draftProject = project.id;
				render();
				return;
			}
			pickProject(async (project) => {
				if (id !== null) await client.updateSession(id, { projectId: project?.id ?? null });
				else ui.draftProject = project?.id ?? null;
				render();
			});
			return;
		case "model":
			pick(
				client.models().map((model) => ({
					value: `${model.provider}/${model.id}`,
					label: model.name,
					description: `${model.provider}${model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k` : ""}`,
				})),
				async (item) => {
					if (id !== null) await client.updateSession(id, { model: item.value });
					else ui.draftModel = item.value;
					render();
				},
				"Model",
			);
			return;
		case "thinking": {
			const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
			const apply = async (level: ThinkingLevel) => {
				if (id !== null) await client.updateSession(id, { thinking: level });
				else ui.draftThinking = level;
				notify(`Thinking: ${level}`);
			};
			if (levels.includes(arg as ThinkingLevel)) await apply(arg as ThinkingLevel);
			else
				pick(
					levels.map((level) => ({ value: level, label: level })),
					(item) => void apply(item.value as ThinkingLevel),
					"Thinking",
				);
			return;
		}
		case "run": {
			const [workflow, ...json] = arg.split(" ");
			const start = async (wfName: string, input: unknown) => {
				const result = await client.runWorkflow({
					name: wfName,
					input,
					...(id !== null ? { sessionId: id } : { projectId: ui.draftProject }),
				});
				openSession(result.sessionId);
			};
			// Without JSON, offer the workflow's own examples (declared in its definition file).
			const chooseInput = (wfName: string) => {
				const examples = client.workflows().find((wf) => wf.name === wfName)?.examples ?? [];
				if (examples.length === 0) return start(wfName, {});
				pick(
					examples.map((example, index) => ({
						value: String(index),
						label: example.label,
						description: JSON.stringify(example.input),
					})),
					(item) => start(wfName, examples[Number(item.value)]!.input),
					`${wfName}: start from an example (or type /run ${wfName} {json})`,
				);
			};
			if (!workflow) {
				pick(
					client.workflows().map((wf) => ({ value: wf.name, label: wf.name, description: wf.description })),
					(item) => chooseInput(item.value),
					"Workflows",
				);
				return;
			}
			if (json.length === 0) await chooseInput(workflow);
			else await start(workflow, JSON.parse(json.join(" ")));
			return;
		}
		case "rename":
			await client.updateSession(needSession(), { title: arg });
			return;
		case "archive":
			await client.updateSession(needSession(), { archived: true });
			newChat();
			return;
		case "pin":
			await client.updateSession(needSession(), { pinned: !current()?.pinned });
			return;
		case "compact":
			await client.compact(needSession(), arg || undefined);
			notify("Compacting…");
			return;
		case "reset":
			await client.reset(needSession());
			return;
		case "continue":
			void client.send(needSession(), arg || "Continue.", "followUp");
			return;
		case "steer":
			if (arg) void client.send(needSession(), arg, "steer");
			else {
				steerNext = true;
				notify("Next message steers the running turn");
			}
			return;
		case "earlier":
			await client.loadEarlier(needSession());
			return;
		case "stop":
			client.abort(needSession());
			return;
		case "quit":
		case "exit":
			quit();
			return;
		default:
			notify(`Unknown command /${name}. Try /help`, "error");
	}
}

const commands: SlashCommand[] = [
	{ name: "new", description: "Start a new chat", argumentHint: "[project]" },
	{ name: "sessions", description: "Switch session" },
	{ name: "project", description: "Pick or add a project folder", argumentHint: "[path]" },
	{ name: "model", description: "Change model" },
	{ name: "thinking", description: "Thinking level", argumentHint: "off|low|medium|high|xhigh" },
	{
		name: "run",
		description: "Run a workflow",
		argumentHint: "<workflow> [json]",
		getArgumentCompletions: (prefix) =>
			client
				.workflows()
				.filter((wf) => wf.name.startsWith(prefix))
				.map((wf) => ({ value: wf.name, label: wf.name, description: wf.description })),
	},
	{ name: "rename", description: "Rename this session", argumentHint: "<title>" },
	{ name: "pin", description: "Pin / unpin this session" },
	{ name: "archive", description: "Archive this session" },
	{ name: "compact", description: "Summarize older context", argumentHint: "[instructions]" },
	{ name: "reset", description: "Start a fresh context in this session" },
	{ name: "continue", description: "Resume after a failed or stopped run" },
	{ name: "steer", description: "Steer the running turn", argumentHint: "<message>" },
	{ name: "earlier", description: "Load earlier messages" },
	{ name: "stop", description: "Stop the running turn" },
	{ name: "help", description: "Show commands" },
	{ name: "quit", description: "Exit" },
];
editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd()));

editor.onSubmit = (text) => {
	editor.setText("");
	void submit(text).catch((error) => notify(error instanceof Error ? error.message : String(error), "error"));
};

let lastCtrlC = 0;
function quit(): void {
	client.close();
	tui.stop();
	process.exit(0);
}

tui.addInputListener((data) => {
	if (tui.hasOverlay()) return undefined;
	if (matchesKey(data, "ctrl+c")) {
		if (editor.getText()) {
			editor.setText("");
			return { consume: true };
		}
		if (Date.now() - lastCtrlC < 1500) quit();
		lastCtrlC = Date.now();
		notify("Press ctrl+c again to quit");
		return { consume: true };
	}
	if (matchesKey(data, "escape") && ui.sessionId !== null && current()?.busy) {
		client.abort(ui.sessionId);
		notify("Stopping…");
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+p")) {
		pickSession();
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+n")) {
		newChat();
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+o")) {
		ui.expanded = !ui.expanded;
		render();
		return { consume: true };
	}
	return undefined;
});

if (ui.sessionId !== null) client.follow(ui.sessionId);
tui.setFocus(editor);
tui.start();
render();
