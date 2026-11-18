import { LoaderCircle } from "lucide-react";
import { cn } from "../../lib/format.ts";

export function Spinner({ className }: { className?: string }) {
	return <LoaderCircle className={cn("size-4 animate-spin", className)} />;
}

/** Three pulsing dots: the model is about to say something. */
export function TypingDots({ className }: { className?: string }) {
	return (
		<span className={cn("inline-flex items-center gap-1 py-2", className)} role="status" aria-label="Working">
			{[0, 150, 300].map((delay) => (
				<span
					key={delay}
					className="size-1.5 animate-pulse rounded-full bg-faint"
					style={{ animationDelay: `${delay}ms` }}
				/>
			))}
		</span>
	);
}
