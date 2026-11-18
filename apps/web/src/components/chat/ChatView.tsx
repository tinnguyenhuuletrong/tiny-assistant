import { buildDisplay, type SendMode, sessionUsage, summarizeLive } from "@tiny/core";
import {
	Archive,
	ArchiveRestore,
	CircleAlert,
	Ellipsis,
	Layers,
	PanelLeft,
	RotateCcw,
	SquarePen,
	Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../lib/client.ts";
import { cn, formatCost, formatTokens } from "../../lib/format.ts";
import { useConnection, useServerState, useSessionView } from "../../lib/store.ts";
import { attempt, toast } from "../../lib/toast.ts";
import { useUi } from "../../lib/ui.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Menu, useMenuAnchor } from "../ui/Menu.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { Composer, type SlashCommand } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import { ModelPicker, ThinkingPicker } from "./Pickers.tsx";

export const CHAT_COMMANDS: SlashCommand[] = [
	{ name: "new", description: "Start a new chat" },
	{ name: "compact", description: "Summarize the conversation to free up context", argHint: "[instructions]" },
	{ name: "reset", description: "Clear the context, keeping a short handoff" },
	{ name: "run", description: "Run a workflow", argHint: "<workflow>" },
];

/** `/run name {json}` → name plus optional JSON input text. */
export function parseRunArg(arg: string): { name?: string; input?: string } {
	const match = /^(\S+)\s*([\s\S]*)$/.exec(arg.trim());
	if (!match) return {};
	return { name: match[1], input: match[2]?.trim() || undefined };
}

export function ChatView({ sessionId }: { sessionId: number }) {
	const ui = useUi();
	const state = useServerState();
	const view = useSessionView(sessionId);
	const connection = useConnection();
	const session = state?.sessions.find((item) => item.id === sessionId);
	const project = session?.projectId ? state?.projects.find((item) => item.id === session.projectId) : undefined;
	const [mode, setMode] = useState<SendMode>("followUp");
	const [stick, setStick] = useState(0);
	const [failed, setFailed] = useState<string | null>(null);
	const menu = useMenuAnchor();

	useEffect(() => {
		client.follow(sessionId);
		const off = client.onError((message, id) => {
			if (id === sessionId) setFailed(message);
		});
		return () => {
			off();
			client.unfollow(sessionId);
		};
	}, [sessionId]);

	// A remembered or linked chat that no longer exists: no session in the list and no view after a while.
	const [missing, setMissing] = useState(false);
	const known = Boolean(view || session || !state);
	useEffect(() => {
		setMissing(false);
		if (known) return;
		const timer = setTimeout(() => setMissing(true), 3000);
		return () => clearTimeout(timer);
	}, [known]);

	const title = session?.title || session?.preview || "New chat";
	useEffect(() => {
		document.title = `${title} · Tiny`;
		return () => {
			document.title = "Tiny Assistant";
		};
	}, [title]);

	const docs = view?.value.docs;
	// `view` is a new object after every op batch; everything below derives from it.
	const items = useMemo(
		() => (view ? buildDisplay(client.entries(sessionId), view.value.docs) : []),
		[view, sessionId],
	);
	const live = useMemo(() => (docs ? summarizeLive(docs) : null), [docs]);
	const usage = useMemo(() => (docs ? sessionUsage(docs) : null), [docs]);
	const busy = Boolean(session?.busy || live?.busy);

	const models = state?.models ?? [];
	const modelValue = session?.model ?? state?.defaults.model ?? null;
	const currentModel = models.find((model) => `${model.provider}/${model.id}` === modelValue);
	const thinking = session?.thinking ?? state?.defaults.thinking ?? "off";

	const onCommand = useCallback(
		(name: string, arg: string) => {
			switch (name) {
				case "new":
					ui.newChat(session?.projectId ?? null);
					break;
				case "compact":
					toast("Compacting context…", "info");
					void attempt(() => client.compact(sessionId, arg || undefined));
					break;
				case "reset":
					if (window.confirm("Reset this chat's context? The transcript stays, the model starts fresh.")) {
						void attempt(() => client.reset(sessionId));
					}
					break;
				case "run": {
					const { name: workflow, input } = parseRunArg(arg);
					ui.openWorkflows({ name: workflow, input, projectId: session?.projectId ?? null, sessionId });
					break;
				}
			}
		},
		[ui, session?.projectId, sessionId],
	);

	const onSubmit = async (text: string) => {
		setStick((value) => value + 1);
		// false keeps the text in the composer when the message could not be sent.
		return client.send(sessionId, text, busy ? mode : "followUp");
	};

	const lastItem = items[items.length - 1];
	const streamingNow = lastItem?.type === "assistant" && lastItem.streaming;

	const status = live && (
		<div className="mt-4 flex flex-col gap-1.5 text-muted text-xs">
			{live.retry && (
				<div className="flex items-center gap-2 text-warn">
					<Spinner className="size-3" />
					Retrying after an error: {live.retry.error}
				</div>
			)}
			{live.compacting && (
				<div className="flex items-center gap-2">
					<Spinner className="size-3" /> Compacting context…
				</div>
			)}
			{busy && !streamingNow && !live.retry && !live.compacting && (
				<div className="flex items-center gap-2">
					<Spinner className="size-3" /> Working…
				</div>
			)}
			{live.queued > 0 && (
				<div>
					{live.queued} message{live.queued === 1 ? "" : "s"} queued
				</div>
			)}
		</div>
	);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="pt-safe shrink-0 border-border/70 border-b bg-bg/85 backdrop-blur">
				<div className="flex h-12 items-center gap-1.5 px-2 md:px-4">
					<IconButton label="Open sidebar" onClick={ui.showSidebar} className="md:hidden">
						<PanelLeft className="size-5" />
					</IconButton>
					<div className="min-w-0 flex-1 px-1">
						<div className="flex items-center gap-2">
							<h1 className="truncate font-medium text-sm">{title}</h1>
							{busy && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
						</div>
						{project && (
							<div className="truncate text-faint text-xs" title={project.path}>
								{project.name}
							</div>
						)}
					</div>
					{connection !== "open" && (
						<span className="flex items-center gap-1.5 text-warn text-xs">
							<span className="size-1.5 animate-pulse rounded-full bg-warn" />
							<span className="hidden sm:inline">{connection === "connecting" ? "Connecting…" : "Offline"}</span>
						</span>
					)}
					{usage && usage.input + usage.output > 0 && (
						<span className="hidden text-faint text-xs sm:inline" title="Session usage">
							{formatTokens(usage.input + usage.output + usage.cacheRead)} tokens
							{usage.cost > 0 && ` · ${formatCost(usage.cost)}`}
						</span>
					)}
					<IconButton label="New chat" onClick={() => ui.newChat(session?.projectId ?? null)} className="md:hidden">
						<SquarePen className="size-5" />
					</IconButton>
					<IconButton label="More" onClick={menu.toggle}>
						<Ellipsis className="size-5" />
					</IconButton>
					{menu.anchor && (
						<Menu
							anchor={menu.anchor}
							align="end"
							onClose={menu.close}
							items={[
								{
									label: "Run workflow…",
									icon: <Workflow className="size-4" />,
									onSelect: () => onCommand("run", ""),
								},
								{
									label: "Compact context",
									icon: <Layers className="size-4" />,
									onSelect: () => onCommand("compact", ""),
								},
								{
									label: "Reset context",
									icon: <RotateCcw className="size-4" />,
									onSelect: () => onCommand("reset", ""),
								},
								{ kind: "separator" },
								session?.archived
									? {
											label: "Unarchive",
											icon: <ArchiveRestore className="size-4" />,
											onSelect: () => void attempt(() => client.updateSession(sessionId, { archived: false })),
										}
									: {
											label: "Archive",
											icon: <Archive className="size-4" />,
											onSelect: () => void attempt(() => client.updateSession(sessionId, { archived: true })),
										},
							]}
						/>
					)}
				</div>
			</header>

			{view ? (
				<MessageList
					sessionId={sessionId}
					items={items}
					models={state?.models}
					hasEarlier={view.hasEarlier}
					onLoadEarlier={() => client.loadEarlier(sessionId).catch((error) => toast(String(error)))}
					stickSignal={stick}
					footer={status}
				/>
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted text-sm">
					{failed || missing ? (
						<>
							<CircleAlert className="size-6 text-danger" />
							<p>{failed ?? "This chat doesn't exist anymore."}</p>
							<Button onClick={() => ui.newChat()}>Start a new chat</Button>
						</>
					) : (
						<Spinner className="size-5" />
					)}
				</div>
			)}

			<div className="shrink-0 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] md:px-6">
				<Composer
					draftKey={String(sessionId)}
					placeholder={busy ? "Send a follow-up…" : "Reply…"}
					onSubmit={onSubmit}
					busy={busy}
					onStop={() => client.abort(sessionId)}
					commands={CHAT_COMMANDS}
					workflows={state?.workflows}
					onCommand={onCommand}
					autoFocus
					toolbar={
						<>
							<ModelPicker
								value={modelValue}
								models={models}
								onChange={(model) => void attempt(() => client.updateSession(sessionId, { model }))}
							/>
							{(!currentModel || currentModel.reasoning) && (
								<ThinkingPicker
									value={thinking}
									onChange={(level) => void attempt(() => client.updateSession(sessionId, { thinking: level }))}
								/>
							)}
							{busy && (
								<button
									type="button"
									onClick={() => setMode((value) => (value === "followUp" ? "steer" : "followUp"))}
									title={
										mode === "steer"
											? "Steer: delivered to the model mid-run, as soon as possible"
											: "Follow-up: queued until the current run finishes"
									}
									className={cn(
										"rounded-lg px-2 py-1 text-xs transition",
										mode === "steer" ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
									)}
								>
									{mode === "steer" ? "Steer" : "Follow-up"}
								</button>
							)}
						</>
					}
				/>
			</div>
		</div>
	);
}
