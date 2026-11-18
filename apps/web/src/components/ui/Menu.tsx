import { Check } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/format.ts";

export type MenuItem =
	| {
			kind?: "item";
			label: string;
			icon?: ReactNode;
			hint?: string;
			onSelect: () => void;
			danger?: boolean;
			checked?: boolean;
			disabled?: boolean;
	  }
	| { kind: "header"; label: string }
	| { kind: "separator" };

type Props = {
	anchor: HTMLElement;
	items: MenuItem[];
	onClose: () => void;
	align?: "start" | "end";
	minWidth?: number;
};

/** A popover menu in a portal, positioned against its anchor and flipped to fit the viewport. */
export function Menu({ anchor, items, onClose, align = "start", minWidth = 200 }: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden", top: 0, left: 0 });

	useLayoutEffect(() => {
		const menu = ref.current;
		if (!menu) return;
		const rect = anchor.getBoundingClientRect();
		const margin = 8;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const width = Math.min(Math.max(menu.offsetWidth, minWidth), vw - margin * 2);
		const below = vh - rect.bottom - margin;
		const above = rect.top - margin;
		const height = menu.scrollHeight;
		const placeBelow = below >= Math.min(height, 240) || below >= above;
		const maxHeight = Math.max(120, (placeBelow ? below : above) - 4);
		let left = align === "end" ? rect.right - width : rect.left;
		left = Math.min(Math.max(margin, left), vw - width - margin);
		setStyle(
			placeBelow
				? { top: rect.bottom + 4, left, minWidth: width, maxHeight }
				: { bottom: vh - rect.top + 4, left, minWidth: width, maxHeight },
		);
	}, [anchor, align, minWidth]);

	useEffect(() => {
		const onPointer = (event: PointerEvent) => {
			const target = event.target as Node;
			if (ref.current?.contains(target) || anchor.contains(target)) return;
			onClose();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
				return;
			}
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			event.preventDefault();
			const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
			if (buttons.length === 0) return;
			const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
			const next = event.key === "ArrowDown" ? index + 1 : index - 1;
			buttons[(next + buttons.length) % buttons.length]?.focus();
		};
		const onResize = () => onClose();
		document.addEventListener("pointerdown", onPointer, true);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("resize", onResize);
		return () => {
			document.removeEventListener("pointerdown", onPointer, true);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("resize", onResize);
		};
	}, [anchor, onClose]);

	return createPortal(
		<div
			ref={ref}
			role="menu"
			style={style}
			className="scrollbar-thin fixed z-[70] overflow-y-auto rounded-xl border border-border bg-surface p-1 text-sm shadow-lg shadow-black/10"
		>
			{items.map((item, index) => {
				if (item.kind === "separator") {
					// biome-ignore lint/suspicious/noArrayIndexKey: static list
					return <div key={`sep${index}`} className="my-1 h-px bg-border" />;
				}
				if (item.kind === "header") {
					return (
						<div key={`h${item.label}`} className="px-2.5 pt-2 pb-1 font-medium text-faint text-xs">
							{item.label}
						</div>
					);
				}
				return (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: labels can repeat across sections
						key={`${index}${item.label}`}
						type="button"
						role="menuitem"
						disabled={item.disabled}
						onClick={() => {
							onClose();
							item.onSelect();
						}}
						className={cn(
							"flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-50",
							item.danger ? "text-danger" : "text-fg",
						)}
					>
						{item.icon && <span className="flex size-4 shrink-0 items-center justify-center">{item.icon}</span>}
						<span className="min-w-0 flex-1 truncate">{item.label}</span>
						{item.hint && <span className="shrink-0 text-faint text-xs">{item.hint}</span>}
						{item.checked && <Check className="size-4 shrink-0 text-accent" />}
					</button>
				);
			})}
		</div>,
		document.body,
	);
}

/** State for a menu opened from a button: `open(event)` anchors it to the clicked element. */
export function useMenuAnchor() {
	const [anchor, setAnchor] = useState<HTMLElement | null>(null);
	return {
		anchor,
		open: (event: React.MouseEvent<HTMLElement>) => setAnchor(event.currentTarget),
		toggle: (event: React.MouseEvent<HTMLElement>) => {
			const target = event.currentTarget;
			setAnchor((current) => (current ? null : target));
		},
		close: () => setAnchor(null),
	};
}
