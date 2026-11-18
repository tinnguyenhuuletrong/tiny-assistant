import { X } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/format.ts";

type Props = {
	title: ReactNode;
	onClose: () => void;
	children: ReactNode;
	footer?: ReactNode;
	className?: string;
	/** Hide the header (the body brings its own, e.g. a search field). */
	bare?: boolean;
	/** Align to the top on desktop (command palette) instead of centering. */
	top?: boolean;
};

/** A modal: bottom sheet on phones, centered card on larger screens. */
export function Dialog({ title, onClose, children, footer, className, bare, top }: Props) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	return createPortal(
		<div
			className={cn(
				"fixed inset-0 z-[60] flex justify-center md:p-6",
				top ? "items-end md:items-start md:pt-[12vh]" : "items-end md:items-center",
			)}
		>
			<button
				type="button"
				aria-label="Close"
				tabIndex={-1}
				className="absolute inset-0 cursor-default bg-overlay"
				onClick={onClose}
			/>
			<div
				role="dialog"
				aria-modal="true"
				className={cn(
					"pb-safe relative flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-2xl md:max-w-lg md:rounded-2xl md:pb-0",
					className,
				)}
			>
				{!bare && (
					<div className="flex shrink-0 items-center gap-3 border-border border-b px-4 py-3">
						<h2 className="min-w-0 flex-1 truncate font-semibold text-base">{title}</h2>
						<button
							type="button"
							onClick={onClose}
							className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
							aria-label="Close"
						>
							<X className="size-4" />
						</button>
					</div>
				)}
				<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
				{footer && <div className="shrink-0 border-border border-t px-4 py-3">{footer}</div>}
			</div>
		</div>,
		document.body,
	);
}
