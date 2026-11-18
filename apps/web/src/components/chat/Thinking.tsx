import { ChevronRight, Lightbulb } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/format.ts";
import { Markdown } from "./Markdown.tsx";

/** A thinking block, collapsed by default; shimmers while the model is still thinking. */
export function Thinking({ text, redacted, active }: { text: string; redacted?: boolean; active: boolean }) {
	const [open, setOpen] = useState(false);
	const label = redacted ? "Thinking (redacted)" : active ? "Thinking…" : "Thought process";
	return (
		<div className="my-2">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				disabled={redacted && !text}
				className="inline-flex items-center gap-1.5 rounded-lg py-1 pr-2 text-muted text-sm hover:text-fg"
			>
				<Lightbulb className="size-3.5" />
				<span className={cn(active && "shimmer")}>{label}</span>
				{!(redacted && !text) && <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />}
			</button>
			{open && text && (
				<div className="mt-1 mb-3 border-border border-l-2 pl-4 text-muted text-sm">
					<Markdown text={text} />
				</div>
			)}
		</div>
	);
}
