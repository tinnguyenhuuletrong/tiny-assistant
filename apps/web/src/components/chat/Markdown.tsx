import "katex/dist/katex.min.css";
import { isValidElement, memo, type ReactNode, useDeferredValue, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "../../lib/format.ts";
import { CopyButton } from "../ui/CopyButton.tsx";

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [
	[rehypeKatex, { throwOnError: false, strict: "ignore" }],
	[rehypeHighlight, { detect: false }],
] as const;

function languageOf(children: ReactNode): string | null {
	if (!isValidElement(children)) return null;
	const className = (children.props as { className?: string }).className ?? "";
	return /language-([\w+#.-]+)/.exec(className)?.[1] ?? null;
}

function CodeBlock({ children }: { children?: ReactNode }) {
	const ref = useRef<HTMLPreElement>(null);
	const language = languageOf(children);
	return (
		<div className="code-block">
			<div className="flex items-center justify-between border-border border-b px-3 py-1 text-faint text-xs">
				<span className="font-mono">{language ?? "text"}</span>
				<CopyButton getText={() => ref.current?.textContent ?? ""} showLabel />
			</div>
			<pre ref={ref} className="scrollbar-thin">
				{children}
			</pre>
		</div>
	);
}

const components: Components = {
	pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
	a: ({ children, href }) => (
		<a href={href} target="_blank" rel="noopener noreferrer">
			{children}
		</a>
	),
	table: ({ children }) => (
		<div className="table-wrap scrollbar-thin">
			<table>{children}</table>
		</div>
	),
};

/**
 * LaTeX delimiters `\(…\)` and `\[…\]` are common in model output but unknown to remark-math; rewrite them to `$…$`
 * and `$$…$$` outside code.
 */
function normalizeMath(text: string): string {
	if (!text.includes("\\(") && !text.includes("\\[")) return text;
	return text
		.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
		.map((segment, index) =>
			index % 2 === 1
				? segment
				: segment
						.replace(/\\\[([\s\S]+?)\\\]/g, (_, math: string) => `$$${math}$$`)
						.replace(/\\\(([\s\S]+?)\\\)/g, (_, math: string) => `$${math}$`),
		)
		.join("");
}

type Props = { text: string; streaming?: boolean; className?: string };

/**
 * Markdown with GFM, math, and highlighted code. Memoized on its text, so finished messages never re-parse; while
 * streaming, the deferred value lets React skip intermediate renders under load.
 */
export const Markdown = memo(function Markdown({ text, streaming, className }: Props) {
	const deferred = useDeferredValue(text);
	return (
		<div className={cn("markdown", streaming && "streaming", className)}>
			<ReactMarkdown
				remarkPlugins={remarkPlugins}
				// biome-ignore lint/suspicious/noExplicitAny: unified's plugin tuple types don't survive `as const`
				rehypePlugins={rehypePlugins as any}
				components={components}
			>
				{normalizeMath(deferred)}
			</ReactMarkdown>
		</div>
	);
});
