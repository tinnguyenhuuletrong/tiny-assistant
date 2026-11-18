import type { WorkflowInfo } from "@tiny/core";
import { ArrowLeft, Play, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { client } from "../../lib/client.ts";
import { cn } from "../../lib/format.ts";
import { navigate } from "../../lib/router.ts";
import { sampleFromSchema, schemaFields } from "../../lib/schema.ts";
import { useServerState } from "../../lib/store.ts";
import { attempt } from "../../lib/toast.ts";
import type { WorkflowDialogOptions } from "../../lib/ui.ts";
import { ProjectPicker } from "../chat/Pickers.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Spinner } from "../ui/Spinner.tsx";

function initialInput(workflow: WorkflowInfo): string {
	if (workflow.input === undefined || workflow.input === null) return "";
	const sample = sampleFromSchema(workflow.input);
	return sample === null ? "" : JSON.stringify(sample, null, 2);
}

function WorkflowForm({
	workflow,
	options,
	onBack,
	onClose,
	onAddProject,
}: {
	workflow: WorkflowInfo;
	options: WorkflowDialogOptions;
	onBack: (() => void) | null;
	onClose: () => void;
	onAddProject: () => void;
}) {
	const state = useServerState();
	const [input, setInput] = useState(() => options.input ?? initialInput(workflow));
	const [projectId, setProjectId] = useState<string | null>(options.projectId ?? null);
	const [inChat, setInChat] = useState(false);
	const [running, setRunning] = useState(false);
	const fields = useMemo(() => schemaFields(workflow.input), [workflow.input]);

	let parsed: { ok: true; value: unknown } | { ok: false; error: string };
	try {
		parsed = { ok: true, value: input.trim() ? JSON.parse(input) : undefined };
	} catch (error) {
		parsed = { ok: false, error: error instanceof Error ? error.message : String(error) };
	}

	const run = async () => {
		if (!parsed.ok) return;
		setRunning(true);
		const result = await attempt(() =>
			client.runWorkflow({
				name: workflow.name,
				input: parsed.value,
				projectId,
				sessionId: inChat ? options.sessionId : undefined,
			}),
		);
		setRunning(false);
		if (!result) return;
		onClose();
		navigate({ name: "session", id: result.sessionId });
	};

	return (
		<Dialog
			title={
				<span className="flex items-center gap-2">
					{onBack && (
						<button
							type="button"
							onClick={onBack}
							aria-label="Back"
							className="-ml-1 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
						>
							<ArrowLeft className="size-4" />
						</button>
					)}
					<Workflow className="size-4 text-muted" />
					<span className="truncate font-mono">{workflow.name}</span>
				</span>
			}
			onClose={onClose}
			className="md:max-w-xl"
			footer={
				<div className="flex flex-wrap items-center gap-2">
					{options.sessionId !== undefined && (
						<label className="flex items-center gap-1.5 text-muted text-xs">
							<input type="checkbox" checked={inChat} onChange={(event) => setInChat(event.target.checked)} />
							Run in this chat
						</label>
					)}
					{!inChat && (
						<ProjectPicker
							value={projectId}
							projects={state?.projects ?? []}
							onChange={setProjectId}
							onAddProject={onAddProject}
						/>
					)}
					<div className="flex-1" />
					<Button variant="primary" onClick={() => void run()} disabled={!parsed.ok || running}>
						{running ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />} Run
					</Button>
				</div>
			}
		>
			<div className="space-y-4 px-4 py-4">
				{workflow.description && <p className="text-muted text-sm">{workflow.description}</p>}
				<div>
					<div className="mb-1.5 flex items-center justify-between text-xs">
						<span className="font-medium text-muted">Input (JSON)</span>
						{!parsed.ok && <span className="truncate pl-3 text-danger">{parsed.error}</span>}
					</div>
					<textarea
						value={input}
						onChange={(event) => setInput(event.target.value)}
						spellCheck={false}
						rows={Math.min(14, Math.max(4, input.split("\n").length + 1))}
						placeholder={workflow.input ? "{}" : "This workflow takes no input"}
						className={cn(
							"scrollbar-thin w-full resize-y rounded-xl border bg-code px-3 py-2.5 font-mono text-[13px] leading-relaxed outline-none",
							parsed.ok ? "border-border focus:border-border-strong" : "border-danger/50",
						)}
					/>
				</div>
				{fields.length > 0 && (
					<dl className="space-y-1.5 text-xs">
						{fields.map((field) => (
							<div key={field.name} className="flex gap-2">
								<dt className="shrink-0 font-mono text-fg">
									{field.name}
									{field.required && <span className="text-danger">*</span>}
								</dt>
								<dd className="min-w-0 text-muted">
									<span className="font-mono text-faint">{field.type}</span>
									{field.description && ` — ${field.description}`}
								</dd>
							</div>
						))}
					</dl>
				)}
				<p className="truncate text-faint text-xs" title={workflow.source}>
					{workflow.source}
				</p>
			</div>
		</Dialog>
	);
}

export function WorkflowDialog({
	options,
	onClose,
	onAddProject,
}: {
	options: WorkflowDialogOptions;
	onClose: () => void;
	onAddProject: () => void;
}) {
	const state = useServerState();
	const workflows = state?.workflows ?? [];
	const preselected = options.name ? workflows.find((workflow) => workflow.name === options.name) : undefined;
	const [selected, setSelected] = useState<string | null>(preselected?.name ?? null);
	const [filter, setFilter] = useState(preselected ? "" : (options.name ?? ""));

	const current = selected ? workflows.find((workflow) => workflow.name === selected) : undefined;
	if (current) {
		return (
			<WorkflowForm
				workflow={current}
				options={selected === preselected?.name ? options : { ...options, input: undefined }}
				onBack={() => setSelected(null)}
				onClose={onClose}
				onAddProject={onAddProject}
			/>
		);
	}

	const query = filter.trim().toLowerCase();
	const visible = workflows.filter(
		(workflow) =>
			!query || workflow.name.toLowerCase().includes(query) || workflow.description.toLowerCase().includes(query),
	);

	return (
		<Dialog title="Run a workflow" onClose={onClose}>
			<div className="sticky top-0 z-10 border-border border-b bg-surface px-4 py-3">
				<input
					autoFocus
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
					placeholder="Filter workflows"
					className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-base outline-none focus:border-border-strong md:text-sm"
				/>
			</div>
			<div className="p-2">
				{visible.map((workflow) => (
					<button
						key={workflow.name}
						type="button"
						onClick={() => setSelected(workflow.name)}
						className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2"
					>
						<Workflow className="mt-0.5 size-4 shrink-0 text-muted" />
						<span className="min-w-0 flex-1">
							<span className="block truncate font-medium font-mono text-sm">{workflow.name}</span>
							{workflow.description && (
								<span className="line-clamp-2 block text-muted text-xs">{workflow.description}</span>
							)}
						</span>
					</button>
				))}
				{visible.length === 0 && (
					<p className="px-3 py-8 text-center text-faint text-sm">
						{workflows.length === 0
							? "No workflows yet. Add one under assistant/workflows/ and the daemon picks it up."
							: "No matching workflows"}
					</p>
				)}
			</div>
		</Dialog>
	);
}
