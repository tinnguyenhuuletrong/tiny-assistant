import { type ToolState, toolSummary } from "@tiny/core";
import {
	ChevronRight,
	CircleCheck,
	CircleX,
	Clock,
	FilePen,
	FileText,
	Folder,
	Globe,
	Search,
	Terminal,
	Wrench,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/format.ts";
import { CopyButton } from "../ui/CopyButton.tsx";
import { Spinner } from "../ui/Spinner.tsx";

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function toolIcon(name: string): ReactNode {
	const n = name.toLowerCase();
	const cls = "size-3.5 shrink-0";
	if (n === "bash" || n.includes("shell") || n.includes("exec")) return <Terminal className={cls} />;
	if (n === "edit" || n === "write" || n.includes("patch")) return <FilePen className={cls} />;
	if (n === "read" || n.includes("cat")) return <FileText className={cls} />;
	if (n === "grep" || n === "find" || n.includes("search")) return <Search className={cls} />;
	if (n === "ls" || n.includes("dir")) return <Folder className={cls} />;
	if (n.includes("fetch") || n.includes("web") || n.includes("http")) return <Globe className={cls} />;
	return <Wrench className={cls} />;
}

function StatusIcon({ status }: { status: ToolState["status"] }) {
	switch (status) {
		case "running":
		case "pending":
			return <Spinner className="size-3.5 text-muted" />;
		case "parked":
			return <Clock className="size-3.5 text-warn" />;
		case "done":
			return <CircleCheck className="size-3.5 text-success" />;
		case "error":
			return <CircleX className="size-3.5 text-danger" />;
	}
}

function Output({ text, live, className }: { text: string; live?: boolean; className?: string }) {
	const ref = useRef<HTMLPreElement>(null);
	// Follow live output while the tool runs.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the text grows
	useEffect(() => {
		if (live && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [live, text]);
	return (
		<pre
			ref={ref}
			className={cn(
				"scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-relaxed",
				className,
			)}
		>
			{text}
		</pre>
	);
}

/** A unified diff (or old/new text pair) with added and removed lines tinted. */
function Diff({ text }: { text: string }) {
	return (
		<pre className="scrollbar-thin max-h-72 overflow-auto py-2 font-mono text-[12px] leading-relaxed">
			{text.split("\n").map((line, index) => {
				const tone =
					line.startsWith("+") && !line.startsWith("+++")
						? "bg-success/10 text-success"
						: line.startsWith("-") && !line.startsWith("---")
							? "bg-danger/10 text-danger"
							: line.startsWith("@@")
								? "text-faint"
								: "";
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: lines of a static text
					<div key={index} className={cn("whitespace-pre-wrap break-words px-3", tone)}>
						{line || " "}
					</div>
				);
			})}
		</pre>
	);
}

function editDiff(args: Record<string, unknown>, details: unknown): string | null {
	const fromDetails = str((details as { diff?: unknown } | undefined)?.diff);
	if (fromDetails) return fromDetails;
	const pairs: { oldText: string; newText: string }[] = [];
	const single = {
		oldText: str(args.oldText) ?? str(args.old_string),
		newText: str(args.newText) ?? str(args.new_string),
	};
	if (single.oldText !== undefined && single.newText !== undefined)
		pairs.push({ oldText: single.oldText, newText: single.newText });
	if (Array.isArray(args.edits)) {
		for (const edit of args.edits as Record<string, unknown>[]) {
			const oldText = str(edit?.oldText) ?? str(edit?.old_string);
			const newText = str(edit?.newText) ?? str(edit?.new_string);
			if (oldText !== undefined && newText !== undefined) pairs.push({ oldText, newText });
		}
	}
	if (pairs.length === 0) return null;
	return pairs
		.map(({ oldText, newText }) =>
			[...oldText.split("\n").map((l) => `-${l}`), ...newText.split("\n").map((l) => `+${l}`)].join("\n"),
		)
		.join("\n@@\n");
}

function Section({ label, children, copy }: { label: string; children: ReactNode; copy?: string }) {
	return (
		<div className="border-border border-t first:border-t-0">
			<div className="flex items-center justify-between px-3 pt-1.5 text-[11px] text-faint uppercase tracking-wide">
				<span>{label}</span>
				{copy !== undefined && <CopyButton getText={() => copy} />}
			</div>
			{children}
		</div>
	);
}

function ToolBody({ tool }: { tool: ToolState }) {
	const name = tool.name.toLowerCase();
	const args = tool.args;
	const path = str(args.path) ?? str(args.file_path);
	const live = tool.status === "running";
	const output = tool.output ? (
		<Section label={tool.status === "error" ? "Error" : "Output"} copy={tool.output}>
			<Output text={tool.output} live={live} className={tool.status === "error" ? "text-danger" : undefined} />
		</Section>
	) : null;

	if (name === "bash") {
		const command = str(args.command) ?? "";
		return (
			<>
				<Section label="Command" copy={command}>
					<pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px]">
						<span className="select-none text-faint">$ </span>
						{command}
					</pre>
				</Section>
				{output}
			</>
		);
	}
	if (name === "edit" || name === "write") {
		const diff = name === "edit" ? editDiff(args, tool.details) : null;
		const content = name === "write" ? str(args.content) : undefined;
		return (
			<>
				{path && <div className="break-all px-3 py-2 font-mono text-[12px] text-muted">{path}</div>}
				{diff && (
					<Section label="Changes">
						<Diff text={diff} />
					</Section>
				)}
				{content !== undefined && (
					<Section label="Content" copy={content}>
						<Output text={content} />
					</Section>
				)}
				{tool.status === "error" || (!diff && content === undefined) ? output : null}
			</>
		);
	}
	const argsJson = Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : "";
	return (
		<>
			{argsJson && (
				<Section label="Input">
					<Output text={argsJson} className="text-muted" />
				</Section>
			)}
			{output}
		</>
	);
}

function lastLine(text: string): string {
	const trimmed = text.trimEnd();
	return trimmed.slice(trimmed.lastIndexOf("\n") + 1).slice(0, 200);
}

/** A tool call: one compact line that expands to its input and output. */
export function ToolCard({ tool }: { tool: ToolState }) {
	const [open, setOpen] = useState(false);
	const summary = toolSummary(tool);
	const running = tool.status === "running" || tool.status === "pending";
	const tail = running && !open && tool.output ? lastLine(tool.output) : "";
	return (
		<div
			className={cn(
				"my-2 overflow-hidden rounded-xl border bg-surface/60 text-sm",
				tool.status === "error" ? "border-danger/30" : "border-border",
			)}
		>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2/60"
			>
				<StatusIcon status={tool.status} />
				<span className="flex shrink-0 items-center gap-1.5 font-medium text-fg">
					{toolIcon(tool.name)}
					{tool.name}
				</span>
				<span className="min-w-0 flex-1 truncate font-mono text-muted text-xs">{summary}</span>
				{tool.status === "parked" && <span className="shrink-0 text-warn text-xs">waiting</span>}
				<ChevronRight className={cn("size-4 shrink-0 text-faint transition-transform", open && "rotate-90")} />
			</button>
			{tail && <div className="truncate border-border border-t px-3 py-1 font-mono text-[11px] text-faint">{tail}</div>}
			{open && (
				<div className="border-border border-t bg-code/60">
					<ToolBody tool={tool} />
				</div>
			)}
		</div>
	);
}
