import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { copyText } from "../../lib/clipboard.ts";
import { cn } from "../../lib/format.ts";

export function CopyButton({
	getText,
	className,
	label = "Copy",
	showLabel,
}: {
	getText: () => string;
	className?: string;
	label?: string;
	showLabel?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={async (event) => {
				event.stopPropagation();
				if (await copyText(getText())) {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}
			}}
			className={cn(
				"inline-flex items-center gap-1 rounded-md p-1 text-muted text-xs transition hover:bg-surface-2 hover:text-fg",
				className,
			)}
		>
			{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
			{showLabel && <span>{copied ? "Copied" : label}</span>}
		</button>
	);
}
