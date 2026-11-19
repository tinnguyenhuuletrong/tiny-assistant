import type { EngineInfo, ModelInfo, ProjectInfo, ThinkingLevel } from "@tiny/core";
import { Bot, Brain, ChevronDown, Folder, FolderPlus } from "lucide-react";
import { cn, modelKey, modelName } from "../../lib/format.ts";
import { Menu, type MenuItem, useMenuAnchor } from "../ui/Menu.tsx";

const pill =
	"inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg px-2 py-1 text-muted text-xs transition hover:bg-surface-2 hover:text-fg";

export function ModelPicker({
	value,
	models,
	onChange,
}: {
	value: string | null;
	models: readonly ModelInfo[];
	onChange: (key: string) => void;
}) {
	const menu = useMenuAnchor();
	const items: MenuItem[] = [];
	let provider = "";
	for (const model of models) {
		if (model.provider !== provider) {
			provider = model.provider;
			items.push({ kind: "header", label: provider });
		}
		const key = modelKey(model);
		items.push({
			label: model.name || model.id,
			hint: model.reasoning ? "reasoning" : undefined,
			checked: key === value,
			onSelect: () => onChange(key),
		});
	}
	if (items.length === 0) items.push({ label: "No models available", disabled: true, onSelect: () => {} });
	return (
		<>
			<button type="button" onClick={menu.toggle} className={pill} title="Model">
				<span className="truncate">{modelName(models, value)}</span>
				<ChevronDown className="size-3 shrink-0" />
			</button>
			{menu.anchor && <Menu anchor={menu.anchor} items={items} onClose={menu.close} minWidth={240} />}
		</>
	);
}

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function ThinkingPicker({
	value,
	onChange,
}: {
	value: ThinkingLevel;
	onChange: (level: ThinkingLevel) => void;
}) {
	const menu = useMenuAnchor();
	return (
		<>
			<button type="button" onClick={menu.toggle} className={pill} title="Thinking level">
				<Brain className="size-3.5 shrink-0" />
				<span className={cn(value === "off" && "text-faint")}>{value === "off" ? "No thinking" : value}</span>
				<ChevronDown className="size-3 shrink-0" />
			</button>
			{menu.anchor && (
				<Menu
					anchor={menu.anchor}
					onClose={menu.close}
					minWidth={160}
					items={[
						{ kind: "header", label: "Thinking" },
						...THINKING_LEVELS.map((level) => ({
							label: level,
							checked: level === value,
							onSelect: () => onChange(level),
						})),
					]}
				/>
			)}
		</>
	);
}

export function ProjectPicker({
	value,
	projects,
	onChange,
	onAddProject,
}: {
	value: string | null;
	projects: readonly ProjectInfo[];
	onChange: (projectId: string | null) => void;
	onAddProject: () => void;
}) {
	const menu = useMenuAnchor();
	const current = projects.find((project) => project.id === value);
	return (
		<>
			<button type="button" onClick={menu.toggle} className={pill} title={current?.path}>
				<Folder className="size-3.5 shrink-0" />
				<span className="truncate">
					Work in: <span className="text-fg">{current?.name ?? "No project"}</span>
				</span>
				<ChevronDown className="size-3 shrink-0" />
			</button>
			{menu.anchor && (
				<Menu
					anchor={menu.anchor}
					onClose={menu.close}
					minWidth={240}
					items={[
						{ label: "No project", checked: value === null, onSelect: () => onChange(null) },
						...(projects.length > 0 ? [{ kind: "header" as const, label: "Projects" }] : []),
						...projects.map((project) => ({
							label: project.name,
							icon: <Folder className="size-4 text-muted" />,
							checked: project.id === value,
							onSelect: () => onChange(project.id),
						})),
						{ kind: "separator" },
						{ label: "Add project…", icon: <FolderPlus className="size-4 text-muted" />, onSelect: onAddProject },
					]}
				/>
			)}
		</>
	);
}

/** What runs the chat's turns: tiny's own loop, Claude Code, ... Each choice carries its note. */
export function EnginePicker({
	value,
	engines,
	onChange,
}: {
	value: string | null;
	engines: readonly EngineInfo[];
	onChange: (engineId: string) => void;
}) {
	const menu = useMenuAnchor();
	const current = engines.find((engine) => engine.id === value);
	if (engines.length < 2) return null;
	return (
		<>
			<button type="button" onClick={menu.toggle} className={pill} title={current?.note}>
				<Bot className="size-3.5 shrink-0" />
				<span className="truncate">{current?.name ?? "Engine"}</span>
				<ChevronDown className="size-3 shrink-0" />
			</button>
			{menu.anchor && (
				<Menu
					anchor={menu.anchor}
					onClose={menu.close}
					minWidth={300}
					maxWidth={380}
					items={[
						{ kind: "header", label: "Run with" },
						...engines.map((engine) => ({
							label: engine.name,
							description: engine.available ? engine.note : (engine.reason ?? "Not available"),
							disabled: !engine.available,
							checked: engine.id === value,
							onSelect: () => onChange(engine.id),
						})),
					]}
				/>
			)}
		</>
	);
}
