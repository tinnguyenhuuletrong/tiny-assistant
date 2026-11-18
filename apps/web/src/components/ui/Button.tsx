import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/format.ts";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
	primary: "bg-fg text-bg hover:opacity-90",
	secondary: "border border-border bg-surface text-fg hover:bg-surface-2",
	ghost: "text-muted hover:bg-surface-2 hover:text-fg",
	danger: "bg-danger text-white hover:opacity-90",
};

export function Button({
	variant = "secondary",
	className,
	type = "button",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
	return (
		<button
			type={type}
			className={cn(
				"inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-sm transition disabled:opacity-40",
				variants[variant],
				className,
			)}
			{...props}
		/>
	);
}

export function IconButton({
	className,
	type = "button",
	label,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
	return (
		<button
			type={type}
			aria-label={label}
			title={label}
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-fg disabled:opacity-40",
				className,
			)}
			{...props}
		/>
	);
}
