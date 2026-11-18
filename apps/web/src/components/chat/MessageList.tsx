import type { DisplayItem, ModelInfo } from "@tiny/core";
import { ArrowDown } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/format.ts";
import { Spinner } from "../ui/Spinner.tsx";
import { ChatItem } from "./ChatItem.tsx";

type Props = {
	sessionId: number;
	items: DisplayItem[];
	models: readonly ModelInfo[] | undefined;
	hasEarlier: boolean;
	onLoadEarlier: () => Promise<void>;
	/** Bumped by the parent to force a jump to the bottom (after sending). */
	stickSignal: number;
	/** Rendered after the last item (live status line). */
	footer?: ReactNode;
};

const NEAR_BOTTOM = 80;

function spacing(item: DisplayItem, previous: DisplayItem | undefined): string {
	if (!previous) return "";
	if (item.type === "workflow" && previous.type === "workflow") return "";
	if (item.type === "assistant" && previous.type === "assistant") return "mt-2";
	return "mt-6";
}

export function MessageList({ sessionId, items, models, hasEarlier, onLoadEarlier, stickSignal, footer }: Props) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const atBottomRef = useRef(true);
	const [atBottom, setAtBottom] = useState(true);
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	/** Scroll height before prepending earlier entries, to keep the reader's place. */
	const anchorRef = useRef<{ height: number; top: number } | null>(null);

	const scrollToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
		atBottomRef.current = true;
		setAtBottom(true);
	}, []);

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
		atBottomRef.current = near;
		setAtBottom(near);
	}, []);

	// Keep pinned to the bottom while content grows (streaming, images, expanding markdown).
	useEffect(() => {
		const content = contentRef.current;
		if (!content) return;
		const observer = new ResizeObserver(() => {
			const el = scrollRef.current;
			if (!el) return;
			const anchor = anchorRef.current;
			if (anchor) {
				el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
				return;
			}
			if (atBottomRef.current) el.scrollTop = el.scrollHeight;
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs whenever the item list changes
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const anchor = anchorRef.current;
		if (anchor) {
			el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
			anchorRef.current = null;
		} else if (atBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [items]);

	useLayoutEffect(() => {
		if (stickSignal > 0) scrollToBottom();
	}, [stickSignal, scrollToBottom]);

	const loadEarlier = async () => {
		const el = scrollRef.current;
		if (!el || loadingEarlier) return;
		setLoadingEarlier(true);
		anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
		try {
			await onLoadEarlier();
		} finally {
			setLoadingEarlier(false);
			// If nothing changed, drop the anchor so it can't apply to a later update.
			requestAnimationFrame(() => {
				anchorRef.current = null;
			});
		}
	};

	let lastAssistant = -1;
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i]!.type === "assistant") {
			lastAssistant = i;
			break;
		}
	}

	return (
		<div className="relative min-h-0 flex-1">
			<div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin h-full overflow-y-auto overscroll-contain">
				<div ref={contentRef} className="mx-auto w-full max-w-3xl px-4 pt-4 pb-6 md:px-6">
					{hasEarlier && (
						<div className="mb-6 flex justify-center">
							<button
								type="button"
								onClick={loadEarlier}
								disabled={loadingEarlier}
								className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-muted text-xs hover:text-fg"
							>
								{loadingEarlier && <Spinner className="size-3" />}
								Load earlier messages
							</button>
						</div>
					)}
					{items.map((item, index) => (
						<div key={item.key} className={spacing(item, items[index - 1])}>
							<ChatItem
								item={item}
								sessionId={sessionId}
								models={models}
								isLast={index === lastAssistant}
								endOfTurn={item.type === "assistant" && items[index + 1]?.type !== "assistant"}
							/>
						</div>
					))}
					{footer}
				</div>
			</div>
			<button
				type="button"
				aria-label="Jump to latest"
				onClick={() => {
					const el = scrollRef.current;
					if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
				}}
				className={cn(
					"-translate-x-1/2 absolute bottom-3 left-1/2 flex size-9 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-md transition hover:text-fg",
					atBottom ? "pointer-events-none scale-90 opacity-0" : "opacity-100",
				)}
			>
				<ArrowDown className="size-4" />
			</button>
		</div>
	);
}
