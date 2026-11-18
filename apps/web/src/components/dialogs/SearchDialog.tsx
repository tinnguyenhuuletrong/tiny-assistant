import type { SearchHit } from "@tiny/core";
import { Bot, MessageSquare, Search, User } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../lib/client.ts";
import { cn, relativeTime } from "../../lib/format.ts";
import { navigate } from "../../lib/router.ts";
import { useServerState } from "../../lib/store.ts";
import { Dialog } from "../ui/Dialog.tsx";
import { Spinner } from "../ui/Spinner.tsx";

type Result = { key: string; sessionId: number; title: string; snippet?: string; role?: SearchHit["role"]; at: number };

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Highlights `<b>`/`<mark>` markers when the server sends them, otherwise the query's words. */
function highlight(snippet: string, query: string): ReactNode {
	if (/<(b|mark)>/i.test(snippet)) {
		return snippet.split(/<(?:b|mark)>([\s\S]*?)<\/(?:b|mark)>/i).map((part, index) =>
			index % 2 === 1 ? (
				// biome-ignore lint/suspicious/noArrayIndexKey: static split
				<mark key={index} className="rounded bg-accent/20 px-0.5 text-fg">
					{part}
				</mark>
			) : (
				part
			),
		);
	}
	const words = query.split(/\s+/).filter((word) => word.length > 1);
	if (words.length === 0) return snippet;
	const pattern = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "gi");
	return snippet.split(pattern).map((part, index) =>
		index % 2 === 1 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: static split
			<mark key={index} className="rounded bg-accent/20 px-0.5 text-fg">
				{part}
			</mark>
		) : (
			part
		),
	);
}

export function SearchDialog({ onClose }: { onClose: () => void }) {
	const state = useServerState();
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<SearchHit[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [active, setActive] = useState(0);
	const request = useRef(0);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const q = query.trim();
		const id = ++request.current;
		if (q.length < 2) {
			setHits(null);
			setLoading(false);
			return;
		}
		setLoading(true);
		const timer = setTimeout(async () => {
			try {
				const result = await client.search(q);
				if (id !== request.current) return;
				setHits(result);
				setError(null);
			} catch (failure) {
				if (id !== request.current) return;
				setError(failure instanceof Error ? failure.message : String(failure));
			} finally {
				if (id === request.current) setLoading(false);
			}
		}, 200);
		return () => clearTimeout(timer);
	}, [query]);

	const results = useMemo<Result[]>(() => {
		if (hits) {
			return hits.map((hit) => ({
				key: `${hit.sessionId}:${hit.entryId}`,
				sessionId: hit.sessionId,
				title: hit.title || "Untitled",
				snippet: hit.snippet,
				role: hit.role,
				at: hit.at,
			}));
		}
		const q = query.trim().toLowerCase();
		return [...(state?.sessions ?? [])]
			.filter((session) => !session.archived && (!q || (session.title || "").toLowerCase().includes(q)))
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 8)
			.map((session) => ({
				key: `s${session.id}`,
				sessionId: session.id,
				title: session.title || session.preview || "New chat",
				at: session.updatedAt,
			}));
	}, [hits, query, state?.sessions]);

	const activeIndex = Math.min(active, Math.max(0, results.length - 1));

	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const open = (result: Result | undefined) => {
		if (!result) return;
		onClose();
		navigate({ name: "session", id: result.sessionId });
	};

	return (
		<Dialog title="Search" bare top onClose={onClose} className="md:max-w-2xl">
			<div className="sticky top-0 z-10 flex items-center gap-3 border-border border-b bg-surface px-4 py-3">
				{loading ? <Spinner className="text-muted" /> : <Search className="size-4 text-muted" />}
				<input
					autoFocus
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							const delta = event.key === "ArrowDown" ? 1 : -1;
							setActive((activeIndex + delta + results.length) % Math.max(1, results.length));
						} else if (event.key === "Enter") {
							event.preventDefault();
							open(results[activeIndex]);
						}
					}}
					placeholder="Search chats…"
					className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
				/>
				<kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[10px] text-faint md:inline">esc</kbd>
			</div>
			<div ref={listRef} className="p-2">
				{!hits && results.length > 0 && <div className="px-3 pt-1 pb-2 text-faint text-xs">Recent</div>}
				{results.map((result, index) => (
					<button
						key={result.key}
						type="button"
						data-index={index}
						onMouseMove={() => setActive(index)}
						onClick={() => open(result)}
						className={cn(
							"flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left",
							index === activeIndex && "bg-surface-2",
						)}
					>
						<span className="mt-0.5 shrink-0 text-muted">
							{result.role === "user" ? (
								<User className="size-4" />
							) : result.role === "assistant" ? (
								<Bot className="size-4" />
							) : (
								<MessageSquare className="size-4" />
							)}
						</span>
						<span className="min-w-0 flex-1">
							<span className="flex items-baseline gap-2">
								<span className="truncate font-medium text-sm">{result.title}</span>
								<span className="ml-auto shrink-0 text-faint text-xs">{relativeTime(result.at)}</span>
							</span>
							{result.snippet && (
								<span className="line-clamp-2 block text-muted text-xs">{highlight(result.snippet, query)}</span>
							)}
						</span>
					</button>
				))}
				{error && <p className="px-3 py-6 text-center text-danger text-sm">{error}</p>}
				{hits && hits.length === 0 && !error && (
					<p className="px-3 py-8 text-center text-faint text-sm">No results for “{query.trim()}”</p>
				)}
			</div>
		</Dialog>
	);
}
