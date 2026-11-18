import type { WorkflowInfo } from "@tiny/core";
import { ArrowLeft, Play, Sparkles, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { client } from "../../lib/client.ts";
import { cn } from "../../lib/format.ts";
import { navigate } from "../../lib/router.ts";
import { type FormField, formFields, isFilled, sampleFromSchema } from "../../lib/schema.ts";
import { useServerState } from "../../lib/store.ts";
import { attempt } from "../../lib/toast.ts";
import type { WorkflowDialogOptions } from "../../lib/ui.ts";
import { ProjectPicker } from "../chat/Pickers.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Spinner } from "../ui/Spinner.tsx";

function pretty(value: unknown): string {
	return value === undefined ? "" : JSON.stringify(value, null, 2);
}

function initialInput(workflow: WorkflowInfo): string {
	// The workflow's own first example is the best starting point; otherwise the schema's required fields.
	const example = workflow.examples?.[0];
	if (example) return pretty(example.input);
	if (workflow.input === undefined || workflow.input === null) return "";
	const sample = sampleFromSchema(workflow.input);
	return sample === null ? "" : pretty(sample);
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
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
	const fields = useMemo(() => formFields(workflow.input), [workflow.input]);
	const [mode, setMode] = useState<"form" | "json">(fields ? "form" : "json");
	// Bumped when the input is replaced wholesale (an example), so form fields drop their in-progress text.
	const [revision, setRevision] = useState(0);

	let parsed: { ok: true; value: unknown } | { ok: false; error: string };
	try {
		parsed = { ok: true, value: input.trim() ? JSON.parse(input) : undefined };
	} catch (error) {
		parsed = { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const values =
		parsed.ok && parsed.value && typeof parsed.value === "object" ? (parsed.value as Record<string, unknown>) : {};
	const missing = parsed.ok && fields ? fields.filter((field) => field.required && !isFilled(values[field.name])) : [];

	const setField = (name: string, value: unknown) => {
		const next = { ...values };
		if (isFilled(value) || value === false || value === 0) next[name] = value;
		else delete next[name];
		setInput(pretty(next));
	};

	const applyExample = (value: unknown) => {
		setInput(pretty(value));
		setRevision((n) => n + 1);
	};

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

	const takesInput = workflow.input !== undefined && workflow.input !== null;

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
					{missing.length > 0 && (
						<span className="text-faint text-xs">Fill in {missing.map((field) => field.name).join(", ")}</span>
					)}
					<Button variant="primary" onClick={() => void run()} disabled={!parsed.ok || missing.length > 0 || running}>
						{running ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />} Run
					</Button>
				</div>
			}
		>
			<div className="space-y-4 px-4 py-4">
				{workflow.description && <p className="text-muted text-sm">{workflow.description}</p>}

				{workflow.examples && workflow.examples.length > 0 && (
					<div>
						<div className="mb-1.5 font-medium text-muted text-xs">Examples</div>
						<div className="flex flex-wrap gap-1.5">
							{workflow.examples.map((example) => {
								const active = parsed.ok && sameJson(parsed.value ?? {}, example.input ?? {});
								return (
									<button
										key={example.label}
										type="button"
										onClick={() => applyExample(example.input)}
										className={cn(
											"flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
											active
												? "border-accent/50 bg-accent/10 text-fg"
												: "border-border text-muted hover:border-border-strong hover:text-fg",
										)}
									>
										<Sparkles className={cn("size-3", active ? "text-accent" : "text-faint")} />
										{example.label}
									</button>
								);
							})}
						</div>
					</div>
				)}

				{takesInput && (
					<div>
						<div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
							<span className="font-medium text-muted">Input</span>
							{fields && (
								<div className="flex rounded-lg border border-border p-0.5">
									{(["form", "json"] as const).map((value) => (
										<button
											key={value}
											type="button"
											onClick={() => setMode(value)}
											className={cn(
												"rounded-md px-2 py-0.5",
												mode === value ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
											)}
										>
											{value === "form" ? "Form" : "JSON"}
										</button>
									))}
								</div>
							)}
						</div>

						{mode === "form" && fields && parsed.ok ? (
							<div className="space-y-3" key={revision}>
								{fields.map((field) => (
									<FieldInput
										key={field.name}
										field={field}
										value={values[field.name]}
										onChange={(value) => setField(field.name, value)}
									/>
								))}
							</div>
						) : (
							<>
								{mode === "form" && !parsed.ok && (
									<p className="mb-1.5 text-danger text-xs">Fix the JSON to use the form: {parsed.error}</p>
								)}
								{mode === "json" && !parsed.ok && <p className="mb-1.5 truncate text-danger text-xs">{parsed.error}</p>}
								<textarea
									value={input}
									onChange={(event) => setInput(event.target.value)}
									spellCheck={false}
									rows={Math.min(14, Math.max(4, input.split("\n").length + 1))}
									placeholder="{}"
									className={cn(
										"scrollbar-thin w-full resize-y rounded-xl border bg-code px-3 py-2.5 font-mono text-[13px] leading-relaxed outline-none",
										parsed.ok ? "border-border focus:border-border-strong" : "border-danger/50",
									)}
								/>
							</>
						)}
					</div>
				)}
				{!takesInput && <p className="text-muted text-sm">This workflow takes no input.</p>}

				<p className="truncate text-faint text-xs" title={workflow.source}>
					{workflow.source}
				</p>
			</div>
		</Dialog>
	);
}

const inputClass =
	"w-full rounded-lg border border-border bg-bg px-3 py-2 text-base outline-none focus:border-border-strong md:text-sm";

function FieldInput({
	field,
	value,
	onChange,
}: {
	field: FormField;
	value: unknown;
	onChange: (value: unknown) => void;
}) {
	const id = `wf-field-${field.name}`;
	// Lists keep the text being typed ("a, b, ") and parse it into items on every change.
	const [listText, setListText] = useState(() => (Array.isArray(value) ? value.join(", ") : ""));
	const label = (
		<label htmlFor={id} className="mb-1 flex items-baseline gap-1 text-sm">
			<span className="font-medium font-mono text-[13px]">{field.name}</span>
			{field.required ? <span className="text-danger">*</span> : <span className="text-faint text-xs">optional</span>}
		</label>
	);
	const help =
		field.description || field.kind === "list" ? (
			<p className="mt-1 text-faint text-xs">
				{field.description}
				{field.kind === "list" && `${field.description ? " · " : ""}separate with commas`}
			</p>
		) : null;

	switch (field.kind) {
		case "boolean":
			return (
				<div>
					<label htmlFor={id} className="flex items-center gap-2 text-sm">
						<input
							id={id}
							type="checkbox"
							checked={value === true}
							onChange={(event) => onChange(event.target.checked)}
						/>
						<span className="font-medium font-mono text-[13px]">{field.name}</span>
					</label>
					{help}
				</div>
			);
		case "choice":
			return (
				<div>
					{label}
					<select
						id={id}
						value={typeof value === "string" ? value : ""}
						onChange={(event) => onChange(event.target.value || undefined)}
						className={inputClass}
					>
						{!field.required && <option value="">(none)</option>}
						{field.options?.map((option) => (
							<option key={option} value={option}>
								{option}
							</option>
						))}
					</select>
					{help}
				</div>
			);
		case "number":
			return (
				<div>
					{label}
					<input
						id={id}
						type="number"
						inputMode={field.integer ? "numeric" : "decimal"}
						step={field.integer ? 1 : "any"}
						value={typeof value === "number" ? value : ""}
						onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
						className={inputClass}
					/>
					{help}
				</div>
			);
		case "list":
			return (
				<div>
					{label}
					<input
						id={id}
						value={listText}
						onChange={(event) => {
							setListText(event.target.value);
							const items = event.target.value
								.split(",")
								.map((item) => item.trim())
								.filter(Boolean)
								.map((item) => (field.itemKind === "number" ? Number(item) : item));
							onChange(items);
						}}
						className={inputClass}
					/>
					{help}
				</div>
			);
		default:
			return (
				<div>
					{label}
					<input
						id={id}
						value={typeof value === "string" ? value : ""}
						onChange={(event) => onChange(event.target.value)}
						className={inputClass}
					/>
					{help}
				</div>
			);
	}
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
