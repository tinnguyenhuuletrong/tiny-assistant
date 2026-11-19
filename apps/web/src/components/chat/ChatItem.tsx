import type { AssistantPart, DisplayItem, ModelInfo, UsageInfo, WorkflowEvent } from "@tiny/core";
import {
	ChevronRight,
	CircleAlert,
	CircleCheck,
	CircleX,
	Info,
	Layers,
	Play,
	RotateCcw,
	TriangleAlert,
} from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { client } from "../../lib/client.ts";
import { cn, modelName, usageText } from "../../lib/format.ts";
import { CopyButton } from "../ui/CopyButton.tsx";
import { TypingDots } from "../ui/Spinner.tsx";
import { SentAttachments } from "./Attachments.tsx";
import { Markdown } from "./Markdown.tsx";
import { Thinking } from "./Thinking.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { WorkflowRunCard } from "./WorkflowRunCard.tsx";

type Props = {
	item: DisplayItem;
	sessionId: number;
	models: readonly ModelInfo[] | undefined;
	/** The last assistant message keeps its action row visible. */
	isLast: boolean;
	/** Last assistant message of a turn: the one that gets the action row. */
	endOfTurn: boolean;
};

// ---- user ----

function UserMessage({ item }: { item: Extract<DisplayItem, { type: "user" }> }) {
	const [expanded, setExpanded] = useState(false);
	const long = item.text.length > 1200 || item.text.split("\n").length > 16;
	return (
		<div className="group flex flex-col items-end">
			<SentAttachments attachments={item.attachments} />
			{item.images.length > 0 && (
				<div className="mb-2 flex max-w-[85%] flex-wrap justify-end gap-2">
					{item.images.map((image, index) => (
						<img
							// biome-ignore lint/suspicious/noArrayIndexKey: images of a finished message
							key={index}
							src={`data:${image.mimeType};base64,${image.data}`}
							alt=""
							className="max-h-48 rounded-xl border border-border object-cover"
						/>
					))}
				</div>
			)}
			{item.text && (
				<div className="relative max-w-[85%] rounded-2xl bg-user px-4 py-2.5">
					<div
						className={cn(
							"whitespace-pre-wrap break-words leading-relaxed",
							long &&
								!expanded &&
								"max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
						)}
					>
						{item.text}
					</div>
					{long && (
						<button
							type="button"
							onClick={() => setExpanded((value) => !value)}
							className="mt-1 text-muted text-xs hover:text-fg"
						>
							{expanded ? "Show less" : "Show more"}
						</button>
					)}
				</div>
			)}
			<div className="mt-1 flex h-6 items-center opacity-0 transition group-hover:opacity-100 hover-none:opacity-100">
				<CopyButton getText={() => item.text} />
			</div>
		</div>
	);
}

// ---- assistant ----

function MetaRow({
	text,
	model,
	usage,
	models,
}: {
	text: string;
	model: string | null;
	usage: UsageInfo | null;
	models: Props["models"];
}) {
	return (
		<div className="flex min-h-6 flex-wrap items-center gap-x-2 text-faint text-xs">
			{text && <CopyButton getText={() => text} />}
			{model && <span>{modelName(models, model)}</span>}
			{usage && <span title="Tokens for this message">{usageText(usage)}</span>}
		</div>
	);
}

function partsText(parts: AssistantPart[]): string {
	return parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n\n");
}

function AssistantMessage({
	item,
	models,
	isLast,
	endOfTurn,
}: {
	item: Extract<DisplayItem, { type: "assistant" }>;
	models: Props["models"];
	isLast: boolean;
	endOfTurn: boolean;
}) {
	const [showMeta, setShowMeta] = useState(false);
	const last = item.parts.length - 1;
	const lastPart = item.parts[last];
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: tap-to-reveal details on touch devices; the same info is reachable on hover/focus
		<div
			className="group"
			onClick={(event) => {
				const target = event.target as HTMLElement;
				if (target.closest("a,button,pre,input,summary") || !window.getSelection()?.isCollapsed) return;
				setShowMeta((value) => !value);
			}}
		>
			{item.parts.map((part, index) => {
				const key = part.type === "tool" ? part.tool.callId : `${part.type}${index}`;
				if (part.type === "text")
					return <Markdown key={key} text={part.text} streaming={item.streaming && index === last} />;
				if (part.type === "thinking")
					return (
						<Thinking key={key} text={part.text} redacted={part.redacted} active={item.streaming && index === last} />
					);
				return <ToolCard key={key} tool={part.tool} />;
			})}
			{item.streaming && lastPart?.type !== "text" && <TypingDots />}
			{item.error && (
				<div className="mt-2 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-danger text-sm">
					<CircleAlert className="mt-0.5 size-4 shrink-0" />
					<span className="min-w-0 break-words">{item.error}</span>
				</div>
			)}
			{!item.streaming && endOfTurn && (
				<div
					className={cn(
						"mt-1 transition",
						isLast || showMeta ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
					)}
				>
					<MetaRow text={partsText(item.parts)} model={item.model} usage={item.usage} models={models} />
				</div>
			)}
		</div>
	);
}

// ---- dividers ----

function Divider({ icon, label, detail }: { icon: ReactNode; label: string; detail: string | null }) {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<div className="flex items-center gap-3 text-faint text-xs">
				<div className="h-px flex-1 bg-border" />
				<button
					type="button"
					disabled={!detail}
					onClick={() => setOpen((value) => !value)}
					className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 hover:text-fg disabled:hover:text-faint"
				>
					{icon}
					{label}
					{detail && <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />}
				</button>
				<div className="h-px flex-1 bg-border" />
			</div>
			{open && detail && (
				<div className="mt-3 rounded-xl border border-border bg-surface/60 px-4 py-3 text-muted text-sm">
					<Markdown text={detail} />
				</div>
			)}
		</div>
	);
}

// ---- workflow timeline ----

function WorkflowRow({ event }: { event: WorkflowEvent }) {
	const [open, setOpen] = useState(false);
	let icon: ReactNode;
	let body: ReactNode;
	let detail: string | null = null;
	switch (event.kind) {
		case "started":
			icon = <Play className="size-3 text-accent" />;
			body = (
				<span>
					Started workflow <span className="font-medium text-fg">{event.name}</span>
				</span>
			);
			if (event.input !== undefined && event.input !== null) detail = JSON.stringify(event.input, null, 2);
			break;
		case "step":
			icon =
				event.status === "done" ? (
					<CircleCheck className="size-3 text-success" />
				) : (
					<CircleX className="size-3 text-danger" />
				);
			body = (
				<span>
					<span className="font-medium text-fg">{event.step}</span>
					{event.summary && <span className="text-muted"> — {event.summary}</span>}
				</span>
			);
			break;
		case "log":
			icon =
				event.level === "error" ? (
					<CircleAlert className="size-3 text-danger" />
				) : event.level === "warn" ? (
					<TriangleAlert className="size-3 text-warn" />
				) : (
					<Info className="size-3 text-faint" />
				);
			body = (
				<span
					className={cn(
						"whitespace-pre-wrap break-words font-mono text-xs",
						event.level === "error" ? "text-danger" : event.level === "warn" ? "text-warn" : "text-muted",
					)}
				>
					{event.text}
				</span>
			);
			break;
		case "finished":
			icon =
				event.status === "completed" ? (
					<CircleCheck className="size-3 text-success" />
				) : event.status === "aborted" ? (
					<TriangleAlert className="size-3 text-warn" />
				) : (
					<CircleX className="size-3 text-danger" />
				);
			body = (
				<span>
					Workflow <span className="font-medium text-fg">{event.name}</span> {event.status}
					{event.error && <span className="text-danger">: {event.error}</span>}
				</span>
			);
			if (event.result !== undefined && event.result !== null)
				detail = typeof event.result === "string" ? event.result : JSON.stringify(event.result, null, 2);
			break;
	}
	return (
		<div className="relative ml-1.5 border-border border-l pb-2 pl-5 text-muted text-sm">
			<span className="absolute top-1 -left-[7px] flex size-3.5 items-center justify-center rounded-full bg-bg">
				{icon}
			</span>
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">{body}</div>
				{detail && (
					<button
						type="button"
						onClick={() => setOpen((value) => !value)}
						className="shrink-0 rounded px-1 text-faint text-xs hover:text-fg"
					>
						{open ? "hide" : event.kind === "started" ? "input" : "result"}
					</button>
				)}
			</div>
			{open && detail && (
				<pre className="scrollbar-thin mt-1.5 max-h-60 overflow-auto rounded-lg border border-border bg-code px-3 py-2 font-mono text-[12px]">
					{detail}
				</pre>
			)}
		</div>
	);
}

// ---- notice ----

function Notice({ item, sessionId }: { item: Extract<DisplayItem, { type: "notice" }>; sessionId: number }) {
	if (!item.resumable) {
		return (
			<div
				className={cn(
					"flex items-start gap-2 px-1 text-xs leading-relaxed",
					item.level === "info" ? "text-faint" : item.level === "warn" ? "text-warn" : "text-danger",
				)}
			>
				{item.level === "info" ? (
					<Info className="mt-0.5 size-3.5 shrink-0" />
				) : (
					<TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
				)}
				<p className="min-w-0 break-words">{item.text}</p>
			</div>
		);
	}
	const tone =
		item.level === "error"
			? "border-danger/30 bg-danger/5"
			: item.level === "warn"
				? "border-warn/30 bg-warn/5"
				: "border-border bg-surface/60";
	return (
		<div className={cn("flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm", tone)}>
			{item.level === "info" ? (
				<Info className="size-4 shrink-0 text-muted" />
			) : (
				<TriangleAlert className={cn("size-4 shrink-0", item.level === "error" ? "text-danger" : "text-warn")} />
			)}
			<div className="min-w-0 flex-1">
				<p className="break-words">{item.text}</p>
				<p className="text-muted text-xs">Send a message to pick up where it left off.</p>
			</div>
			<button
				type="button"
				onClick={() => client.send(sessionId, "Continue")}
				className="shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 font-medium text-sm hover:bg-surface-2"
			>
				Continue
			</button>
		</div>
	);
}

// ---- item ----

function ItemView({ item, sessionId, models, isLast, endOfTurn }: Props) {
	switch (item.type) {
		case "user":
			return <UserMessage item={item} />;
		case "assistant":
			return <AssistantMessage item={item} models={models} isLast={isLast} endOfTurn={endOfTurn} />;
		case "compaction":
			return <Divider icon={<Layers className="size-3" />} label="Context compacted" detail={item.summary || null} />;
		case "reset":
			return <Divider icon={<RotateCcw className="size-3" />} label="Context reset" detail={item.handoff} />;
		case "workflow":
			return <WorkflowRow event={item.event} />;
		case "workflow-run":
			return <WorkflowRunCard run={item.run} sessionId={sessionId} />;
		case "notice":
			return <Notice item={item} sessionId={sessionId} />;
	}
}

function samePart(a: AssistantPart, b: AssistantPart): boolean {
	if (a.type !== b.type) return false;
	if (a.type === "tool" && b.type === "tool") {
		const x = a.tool;
		const y = b.tool;
		return (
			x.callId === y.callId &&
			x.status === y.status &&
			x.output === y.output &&
			x.name === y.name &&
			x.args === y.args &&
			x.details === y.details
		);
	}
	if (a.type === "thinking" && b.type === "thinking") return a.text === b.text && a.redacted === b.redacted;
	return (a as { text: string }).text === (b as { text: string }).text;
}

function sameUsage(a: UsageInfo | null, b: UsageInfo | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cost === b.cost;
}

/**
 * `buildDisplay` makes fresh objects on every op, so compare by content. View data is immutable and structurally
 * shared, so strings and argument objects of finished entries are the same references and these checks are cheap.
 */
function sameItem(prev: Props, next: Props): boolean {
	if (
		prev.sessionId !== next.sessionId ||
		prev.models !== next.models ||
		prev.isLast !== next.isLast ||
		prev.endOfTurn !== next.endOfTurn
	)
		return false;
	const a = prev.item;
	const b = next.item;
	if (a === b) return true;
	if (a.type !== b.type || a.key !== b.key) return false;
	switch (a.type) {
		case "user": {
			const y = b as typeof a;
			return a.text === y.text && a.images.length === y.images.length && a.attachments.length === y.attachments.length;
		}
		case "assistant": {
			const y = b as typeof a;
			return (
				a.streaming === y.streaming &&
				a.error === y.error &&
				a.model === y.model &&
				sameUsage(a.usage, y.usage) &&
				a.parts.length === y.parts.length &&
				a.parts.every((part, index) => samePart(part, y.parts[index]!))
			);
		}
		case "notice": {
			const y = b as typeof a;
			return a.text === y.text && a.level === y.level && a.resumable === y.resumable;
		}
		case "workflow-run":
			// A run's card changes as its later entries arrive.
			return JSON.stringify(a.run) === JSON.stringify((b as typeof a).run);
		default:
			// Compaction, reset, and workflow items come from committed entries, which never change.
			return a.entryId === (b as typeof a).entryId;
	}
}

export const ChatItem = memo(ItemView, sameItem);
