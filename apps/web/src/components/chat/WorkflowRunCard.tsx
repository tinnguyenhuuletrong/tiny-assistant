import type { WorkflowRun, WorkflowStepStatus } from "@tiny/core";
import { ChevronRight, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/format.ts";
import { Markdown } from "./Markdown.tsx";

/**
 * A workflow run as a live diagram: a rail of step nodes (running ones pulse), and, when the run fails or is stopped,
 * a rollback lane with arrows back into every step that was undone.
 */
export function WorkflowRunCard({ run }: { run: WorkflowRun }) {
	const [showLogs, setShowLogs] = useState(false);
	const active = run.phase === "running" || run.phase === "rolling_back";
	return (
		<div className="overflow-hidden rounded-2xl border border-border bg-surface/60">
			<div className="flex items-center gap-2 border-border/70 border-b px-4 py-2.5">
				<Workflow className="size-4 shrink-0 text-accent" />
				<span className="min-w-0 truncate font-medium text-sm">{run.name}</span>
				<span className="text-faint text-xs">run {run.runId}</span>
				<PhaseBadge phase={run.phase} />
			</div>

			<div className="px-3 py-3">
				{run.steps.length >= 2 || (run.steps.length >= 1 && run.phase === "rolling_back") ? (
					<StepGraph run={run} />
				) : run.steps.length === 1 ? (
					<SingleStep name={run.steps[0]!.name} status={run.steps[0]!.status} summary={run.steps[0]!.summary} />
				) : (
					<p className="px-1 text-muted text-sm">{active ? "Starting…" : "No steps ran."}</p>
				)}
			</div>

			{run.logs.length > 0 && (
				<div className="border-border/70 border-t px-4 py-2">
					<button
						type="button"
						onClick={() => setShowLogs((value) => !value)}
						className="flex items-center gap-1 text-muted text-xs hover:text-fg"
					>
						<ChevronRight className={cn("size-3 transition-transform", showLogs && "rotate-90")} />
						Logs ({run.logs.length})
					</button>
					{showLogs && (
						<div className="scrollbar-thin mt-2 max-h-56 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-[12px]">
							{run.logs.map((log, index) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: logs are append-only
									key={index}
									className={cn(
										"whitespace-pre-wrap break-words",
										log.level === "error" ? "text-danger" : log.level === "warn" ? "text-warn" : "text-muted",
									)}
								>
									{log.text}
								</div>
							))}
						</div>
					)}
				</div>
			)}

			<Outcome run={run} />
		</div>
	);
}

function PhaseBadge({ phase }: { phase: WorkflowRun["phase"] }) {
	const styles: Record<WorkflowRun["phase"], [string, string]> = {
		running: ["Running", "bg-accent/12 text-accent"],
		rolling_back: ["Rolling back", "bg-warn/15 text-warn"],
		completed: ["Completed", "bg-success/12 text-success"],
		failed: ["Failed", "bg-danger/12 text-danger"],
		aborted: ["Stopped", "bg-warn/15 text-warn"],
	};
	const [label, style] = styles[phase];
	const live = phase === "running" || phase === "rolling_back";
	return (
		<span className={cn("ml-auto flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium text-xs", style)}>
			{live && <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />}
			{label}
		</span>
	);
}

function Outcome({ run }: { run: WorkflowRun }) {
	if (run.phase === "running" || run.phase === "rolling_back") return null;
	const result = run.result;
	return (
		<div className="space-y-1 border-border/70 border-t px-4 py-2.5 text-sm">
			{run.error && <p className="text-danger">{run.error}</p>}
			{run.rolledBack.length > 0 && (
				<p className="text-muted text-xs">
					Rolled back {run.rolledBack.length} step{run.rolledBack.length === 1 ? "" : "s"}: {run.rolledBack.join(" ← ")}
				</p>
			)}
			{run.phase === "completed" && result !== undefined && result !== null && (
				<div className="text-fg">
					{typeof result === "string" ? (
						<Markdown text={result} />
					) : (
						<pre className="scrollbar-thin overflow-x-auto font-mono text-xs">{JSON.stringify(result, null, 2)}</pre>
					)}
				</div>
			)}
		</div>
	);
}

// ---- diagram ----

const STATUS: Record<WorkflowStepStatus, { label: string; color: string; live?: boolean; struck?: boolean }> = {
	running: { label: "running", color: "var(--accent)", live: true },
	done: { label: "done", color: "var(--success)" },
	failed: { label: "failed", color: "var(--danger)" },
	undoing: { label: "undoing", color: "var(--warn)", live: true },
	undone: { label: "undone", color: "var(--warn)", struck: true },
	undo_failed: { label: "undo failed", color: "var(--danger)" },
};

const ROW = 54; // vertical distance between nodes
const NODE_H = 42;
const RAIL_X = 14;
const NODE_X = 34;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
	const ref = useRef<T>(null);
	const [width, setWidth] = useState(560);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, width];
}

function fit(text: string, maxWidth: number, charWidth: number): string {
	const max = Math.max(4, Math.floor(maxWidth / charWidth));
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function StepGraph({ run }: { run: WorkflowRun }) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const undoSteps = run.steps
		.map((step, index) => ({ step, index }))
		.filter(({ step }) => step.status === "undoing" || step.status === "undone" || step.status === "undo_failed");
	const rollback = run.phase === "rolling_back" || undoSteps.length > 0;
	const laneWidth = rollback ? 64 : 0;
	const nodeWidth = Math.max(160, Math.min(440, width - NODE_X - laneWidth - 4));
	// While running between steps (the last one finished), show where the next step will appear.
	const ghost = run.phase === "running" && run.steps.at(-1)?.status === "done";
	const count = run.steps.length + (ghost ? 1 : 0);
	const height = count * ROW - (ROW - NODE_H) + 4;
	const y = (index: number) => 2 + index * ROW;
	const center = (index: number) => y(index) + NODE_H / 2;

	// Where the rollback starts: the step that failed, or (after a stop) the newest step.
	const failedIndex = run.steps.findIndex((step) => step.status === "failed");
	const origin = failedIndex >= 0 ? failedIndex : run.steps.length - 1;
	const laneX = NODE_X + nodeWidth + 30;
	const topUndo = undoSteps.length > 0 ? Math.min(...undoSteps.map(({ index }) => index)) : origin;

	return (
		<div ref={ref} className="w-full">
			<svg
				width={width}
				height={height}
				viewBox={`0 0 ${width} ${height}`}
				role="img"
				aria-label={`Workflow ${run.name}: ${run.steps.map((step) => `${step.name} ${STATUS[step.status].label}`).join(", ")}`}
				className="block overflow-visible"
			>
				<defs>
					<marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
						<path d="M0,0 L10,5 L0,10 z" fill="var(--warn)" />
					</marker>
				</defs>

				{/* rail segments: solid once the step above finished */}
				{Array.from({ length: count - 1 }, (_, index) => {
					const above = run.steps[index];
					const solid = above && above.status !== "running" && above.status !== "failed";
					return (
						<line
							// biome-ignore lint/suspicious/noArrayIndexKey: positional segments
							key={index}
							x1={RAIL_X}
							x2={RAIL_X}
							y1={center(index) + 7}
							y2={center(index + 1) - 7}
							stroke={solid ? "var(--border-strong)" : "var(--border)"}
							strokeWidth={2}
							strokeDasharray={solid ? undefined : "3 4"}
						/>
					);
				})}

				{run.steps.map((step, index) => {
					const style = STATUS[step.status];
					const secondary = step.summary ?? style.label;
					return (
						<g key={step.name}>
							<StatusDot x={RAIL_X} y={center(index)} status={step.status} />
							<rect
								x={NODE_X}
								y={y(index)}
								width={nodeWidth}
								height={NODE_H}
								rx={10}
								fill="var(--surface)"
								stroke={step.status === "done" ? "var(--border)" : style.color}
								strokeWidth={step.status === "done" ? 1 : 1.5}
								strokeDasharray={step.status === "undone" ? "4 3" : undefined}
								className={style.live ? "motion-safe:animate-pulse" : undefined}
							/>
							<text
								x={NODE_X + 12}
								y={y(index) + 17}
								fontSize={13}
								fontWeight={500}
								fill={style.struck ? "var(--muted)" : "var(--fg)"}
								textDecoration={style.struck ? "line-through" : undefined}
							>
								{fit(step.name, nodeWidth - 24, 7.4)}
							</text>
							<text x={NODE_X + 12} y={y(index) + 33} fontSize={11} fill={style.color}>
								{fit(secondary, nodeWidth - 24, 6.2)}
							</text>
						</g>
					);
				})}

				{ghost && (
					<g>
						<circle
							cx={RAIL_X}
							cy={center(count - 1)}
							r={5}
							fill="none"
							stroke="var(--border-strong)"
							strokeDasharray="2 2"
						/>
						<rect
							x={NODE_X}
							y={y(count - 1)}
							width={nodeWidth}
							height={NODE_H}
							rx={10}
							fill="none"
							stroke="var(--border)"
							strokeDasharray="4 4"
						/>
						<text x={NODE_X + 12} y={y(count - 1) + 26} fontSize={12} fill="var(--faint)">
							…
						</text>
					</g>
				)}

				{rollback && run.steps.length > 0 && (
					<g>
						{/* from the failed step out to the lane, up the lane, and into each undone step */}
						<path
							d={`M ${NODE_X + nodeWidth} ${center(origin)} H ${laneX} V ${center(topUndo)}`}
							fill="none"
							stroke="var(--warn)"
							strokeWidth={1.5}
							strokeDasharray="5 4"
						/>
						{undoSteps.map(({ step, index }) => (
							<line
								key={step.name}
								x1={laneX}
								x2={NODE_X + nodeWidth + 3}
								y1={center(index)}
								y2={center(index)}
								stroke="var(--warn)"
								strokeWidth={1.5}
								strokeDasharray="5 4"
								markerEnd="url(#wf-arrow)"
							/>
						))}
						<text
							x={laneX + 8}
							y={(center(origin) + center(topUndo)) / 2}
							fontSize={11}
							fill="var(--warn)"
							dominantBaseline="middle"
						>
							undo
						</text>
					</g>
				)}
			</svg>
		</div>
	);
}

function StatusDot({ x, y, status }: { x: number; y: number; status: WorkflowStepStatus }) {
	const style = STATUS[status];
	const filled = status === "done" || status === "failed" || status === "undone" || status === "undo_failed";
	return (
		<g>
			{style.live && (
				<circle
					cx={x}
					cy={y}
					r={9}
					fill={style.color}
					opacity={0.25}
					className="motion-safe:animate-ping"
					style={{ transformOrigin: `${x}px ${y}px` }}
				/>
			)}
			<circle cx={x} cy={y} r={6} fill={filled ? style.color : "var(--surface)"} stroke={style.color} strokeWidth={2} />
			{status === "done" && (
				<path d={`M ${x - 3} ${y} l 2 2 l 4 -4`} stroke="var(--surface)" strokeWidth={1.6} fill="none" />
			)}
			{(status === "failed" || status === "undo_failed") && (
				<path
					d={`M ${x - 2.5} ${y - 2.5} l 5 5 M ${x + 2.5} ${y - 2.5} l -5 5`}
					stroke="var(--surface)"
					strokeWidth={1.6}
				/>
			)}
			{status === "undone" && (
				<text
					x={x}
					y={y + 0.5}
					fontSize={9}
					fontWeight={700}
					fill="var(--surface)"
					textAnchor="middle"
					dominantBaseline="central"
				>
					↺
				</text>
			)}
		</g>
	);
}

function SingleStep({ name, status, summary }: { name: string; status: WorkflowStepStatus; summary?: string }) {
	const style = STATUS[status];
	return (
		<div className="flex items-center gap-2 px-1 text-sm">
			<svg width={20} height={20} viewBox="0 0 20 20" aria-hidden="true">
				<StatusDot x={10} y={10} status={status} />
			</svg>
			<span className={cn("font-medium", style.struck && "text-muted line-through")}>{name}</span>
			<span className="text-xs" style={{ color: style.color }}>
				{summary ?? style.label}
			</span>
		</div>
	);
}
