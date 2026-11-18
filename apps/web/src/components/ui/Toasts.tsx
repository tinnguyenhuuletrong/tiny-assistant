import { CircleAlert, Info, X } from "lucide-react";
import { cn } from "../../lib/format.ts";
import { dismissToast, useToasts } from "../../lib/toast.ts";

export function Toasts() {
	const toasts = useToasts();
	if (toasts.length === 0) return null;
	return (
		<div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[80] flex flex-col items-center gap-2 px-4">
			{toasts.map((toast) => (
				<div
					key={toast.id}
					role="status"
					className={cn(
						"pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border bg-surface px-3.5 py-2.5 text-sm shadow-lg",
						toast.level === "error" ? "border-danger/40" : "border-border",
					)}
				>
					{toast.level === "error" ? (
						<CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
					) : (
						<Info className="mt-0.5 size-4 shrink-0 text-muted" />
					)}
					<p className="min-w-0 flex-1 break-words">{toast.text}</p>
					<button
						type="button"
						aria-label="Dismiss"
						onClick={() => dismissToast(toast.id)}
						className="shrink-0 rounded p-0.5 text-muted hover:text-fg"
					>
						<X className="size-3.5" />
					</button>
				</div>
			))}
		</div>
	);
}
