import type { AttachmentInfo, MediaSupport, WorkflowInfo } from "@tiny/core";
import { ArrowUp, Square } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/format.ts";
import { useCoarsePointer } from "../../lib/media.ts";
import { KEYS, load, save } from "../../lib/storage.ts";
import { toast } from "../../lib/toast.ts";
import { AttachButton, PendingFiles, usePendingFiles } from "./Attachments.tsx";

export type SlashCommand = { name: string; description: string; argHint?: string };

/** An image the browser made from clipboard data (no file behind it): named `image.png` and the like. */
function isClipboardPicture(file: File): boolean {
	return file.type.startsWith("image/") && /^image\.\w+$/i.test(file.name);
}

type Suggestion = { id: string; label: string; hint?: string; description: string; apply: () => void };

type Props = {
	/** Unsent text is kept per scope in localStorage. */
	draftKey: string;
	placeholder: string;
	/** Return `false` to keep the text and files (e.g. the request failed). */
	onSubmit: (text: string, attachments: AttachmentInfo[]) => unknown;
	/** What the engine takes besides text; absent: no attachments. */
	media?: MediaSupport;
	busy?: boolean;
	onStop?: () => void;
	commands?: SlashCommand[];
	workflows?: readonly WorkflowInfo[];
	onCommand?: (name: string, arg: string) => void;
	/** Controls on the left of the bottom bar (model, thinking, mode). */
	toolbar?: ReactNode;
	/** A line above the input (e.g. the project picker). */
	header?: ReactNode;
	autoFocus?: boolean;
	submitting?: boolean;
	className?: string;
};

export function Composer({
	draftKey,
	placeholder,
	onSubmit,
	media,
	busy,
	onStop,
	commands = [],
	workflows = [],
	onCommand,
	toolbar,
	header,
	autoFocus,
	submitting,
	className,
}: Props) {
	const coarse = useCoarsePointer();
	const [value, setValue] = useState(() => load<string>(KEYS.draft(draftKey), ""));
	const [active, setActive] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const ref = useRef<HTMLTextAreaElement>(null);
	const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const pending = usePendingFiles(media);
	const [dragging, setDragging] = useState(false);

	useEffect(() => {
		clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => save(KEYS.draft(draftKey), value || null), 300);
		return () => clearTimeout(saveTimer.current);
	}, [draftKey, value]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text changes
	useLayoutEffect(() => {
		const area = ref.current;
		if (!area) return;
		area.style.height = "auto";
		area.style.height = `${Math.min(area.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
	}, [value]);

	useEffect(() => {
		if (autoFocus && !coarse) ref.current?.focus();
	}, [autoFocus, coarse]);

	const clear = () => {
		setValue("");
		save(KEYS.draft(draftKey), null);
	};

	const runCommand = (name: string, arg: string) => {
		clear();
		onCommand?.(name, arg);
	};

	const suggestions = ((): Suggestion[] => {
		if (!onCommand || commands.length === 0) return [];
		const run = /^\/run\s+(\S*)$/.exec(value);
		if (run && commands.some((command) => command.name === "run")) {
			const query = (run[1] ?? "").toLowerCase();
			return workflows
				.filter((workflow) => workflow.name.toLowerCase().includes(query))
				.slice(0, 8)
				.map((workflow) => ({
					id: `wf:${workflow.name}`,
					label: workflow.name,
					description: workflow.description,
					apply: () => runCommand("run", workflow.name),
				}));
		}
		const match = /^\/(\S*)$/.exec(value);
		if (!match) return [];
		const query = (match[1] ?? "").toLowerCase();
		return commands
			.filter((command) => command.name.startsWith(query))
			.map((command) => ({
				id: command.name,
				label: `/${command.name}`,
				hint: command.argHint,
				description: command.description,
				apply: () => {
					if (command.argHint) {
						setValue(`/${command.name} `);
						ref.current?.focus();
					} else {
						runCommand(command.name, "");
					}
				},
			}));
	})();

	const showSuggestions = suggestions.length > 0 && dismissed !== value;
	const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1));

	const submit = async () => {
		const text = value.trim();
		const attachments = pending.ready;
		if ((!text && attachments.length === 0) || submitting || pending.uploading) return;
		if (pending.files.some((file) => file.status === "error")) {
			toast("Remove the files that failed to upload first");
			return;
		}
		if (onCommand && text.startsWith("/") && pending.files.length === 0) {
			const [, name = "", arg = ""] = /^\/(\S+)\s*([\s\S]*)$/.exec(text) ?? [];
			if (commands.some((command) => command.name === name)) {
				runCommand(name, arg.trim());
				return;
			}
		}
		const result = await onSubmit(text, attachments);
		if (result !== false) {
			clear();
			pending.clear();
		}
	};

	/** Ctrl/Cmd+V with an image or files on the clipboard attaches them; plain text pastes as usual. */
	const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
		if (!media) return;
		const files = Array.from(event.clipboardData.files);
		if (files.length === 0) return;
		// Excel, Numbers, Word, and PowerPoint put a picture of the selection next to its text: that is a text paste.
		// Their picture is an unnamed clipboard image; files copied in Finder keep their names.
		const text = event.clipboardData.getData("text/plain");
		if (text.trim() && files.every((file) => isClipboardPicture(file))) return;
		event.preventDefault();
		pending.add(files);
	};

	const dropProps = media
		? {
				onDragOver: (event: React.DragEvent) => {
					if (!event.dataTransfer.types.includes("Files")) return;
					event.preventDefault();
					setDragging(true);
				},
				onDragLeave: (event: React.DragEvent) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
				},
				onDrop: (event: React.DragEvent) => {
					if (!event.dataTransfer.types.includes("Files")) return;
					event.preventDefault();
					setDragging(false);
					pending.add(Array.from(event.dataTransfer.files));
				},
			}
		: {};

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (showSuggestions) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const delta = event.key === "ArrowDown" ? 1 : -1;
				setActive((activeIndex + delta + suggestions.length) % suggestions.length);
				return;
			}
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
				event.preventDefault();
				suggestions[activeIndex]?.apply();
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissed(value);
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey && !coarse) {
			event.preventDefault();
			void submit();
		}
	};

	const canSend =
		(value.trim().length > 0 || pending.ready.length > 0) &&
		!submitting &&
		!pending.uploading &&
		!pending.files.some((file) => file.status === "error");

	return (
		<div className={cn("relative mx-auto w-full max-w-3xl", className)}>
			{showSuggestions && (
				<div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-lg">
					{suggestions.map((suggestion, index) => (
						<button
							key={suggestion.id}
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onMouseEnter={() => setActive(index)}
							onClick={suggestion.apply}
							className={cn(
								"flex w-full items-baseline gap-3 rounded-lg px-3 py-2 text-left text-sm",
								index === activeIndex && "bg-surface-2",
							)}
						>
							<span className="shrink-0 font-medium font-mono">{suggestion.label}</span>
							{suggestion.hint && <span className="shrink-0 font-mono text-faint text-xs">{suggestion.hint}</span>}
							<span className="min-w-0 flex-1 truncate text-muted text-xs">{suggestion.description}</span>
						</button>
					))}
				</div>
			)}
			<div
				{...dropProps}
				className={cn(
					"rounded-2xl border border-border bg-surface shadow-black/5 shadow-sm transition focus-within:border-border-strong",
					dragging && "border-accent ring-2 ring-accent/30",
				)}
			>
				{header}
				<PendingFiles files={pending.files} onRemove={pending.remove} />
				<textarea
					ref={ref}
					value={value}
					rows={1}
					placeholder={placeholder}
					onChange={(event) => {
						setValue(event.target.value);
						setActive(0);
					}}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					enterKeyHint={coarse ? "enter" : "send"}
					className="scrollbar-thin block max-h-[40vh] w-full resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-base leading-relaxed outline-none placeholder:text-faint"
				/>
				<div className="flex items-center gap-1 px-2 pb-2">
					{media && <AttachButton media={media} onFiles={pending.add} />}
					<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{toolbar}</div>
					{busy && onStop && (
						<button
							type="button"
							onClick={onStop}
							aria-label="Stop"
							title="Stop"
							className={cn(
								"flex size-8 shrink-0 items-center justify-center rounded-lg transition",
								canSend ? "text-muted hover:bg-surface-2 hover:text-fg" : "bg-fg text-bg hover:opacity-90",
							)}
						>
							<Square className="size-3.5" fill="currentColor" />
						</button>
					)}
					{(!busy || canSend) && (
						<button
							type="button"
							onClick={() => void submit()}
							disabled={!canSend}
							aria-label="Send"
							title={coarse ? "Send" : "Send (Enter)"}
							className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg transition hover:opacity-90 disabled:bg-surface-2 disabled:text-faint"
						>
							<ArrowUp className="size-4" strokeWidth={2.5} />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
