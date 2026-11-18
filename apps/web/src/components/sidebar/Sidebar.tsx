import type { ProjectInfo, SessionInfo } from "@tiny/core";
import {
	ChevronRight,
	Ellipsis,
	Folder,
	FolderOpen,
	FolderPlus,
	PanelLeftClose,
	Pencil,
	Plus,
	Search,
	SquarePen,
	Trash2,
	Workflow,
	X,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { client } from "../../lib/client.ts";
import { cn } from "../../lib/format.ts";
import { KEYS, load, save } from "../../lib/storage.ts";
import { useConnection, useServerState } from "../../lib/store.ts";
import { attempt } from "../../lib/toast.ts";
import { useUi } from "../../lib/ui.ts";
import { MoveDialog } from "../dialogs/MoveDialog.tsx";
import { IconButton } from "../ui/Button.tsx";
import { Menu, useMenuAnchor } from "../ui/Menu.tsx";
import { SessionRow } from "./SessionRow.tsx";

type Props = {
	activeId: number | null;
	/** Called after any navigation (closes the drawer on mobile). */
	onNavigate: () => void;
	/** Collapse (desktop) or close (mobile drawer). */
	onHide: () => void;
	mobile: boolean;
};

const PROJECT_PREVIEW = 5;
const DEFAULT_COLLAPSED: Record<string, boolean> = { archived: true };

const byRecent = (a: SessionInfo, b: SessionInfo) => b.updatedAt - a.updatedAt;

function useCollapsed() {
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => load(KEYS.collapsedGroups, {}));
	const isCollapsed = (id: string) => collapsed[id] ?? DEFAULT_COLLAPSED[id] ?? false;
	const toggle = (id: string) => {
		const next = { ...collapsed, [id]: !isCollapsed(id) };
		setCollapsed(next);
		save(KEYS.collapsedGroups, next);
	};
	return { isCollapsed, toggle };
}

function NavButton({
	icon,
	label,
	hint,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	hint?: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-fg/90 text-sm transition hover:bg-surface-2/70"
		>
			<span className="flex size-5 items-center justify-center text-muted group-hover:text-fg">{icon}</span>
			<span className="flex-1">{label}</span>
			{hint && <span className="hidden text-faint text-xs md:inline">{hint}</span>}
		</button>
	);
}

function GroupHeader({
	label,
	icon,
	collapsed,
	onToggle,
	actions,
	title,
}: {
	label: string;
	icon?: ReactNode;
	collapsed: boolean;
	onToggle: () => void;
	actions?: ReactNode;
	title?: string;
}) {
	return (
		<div className="group flex items-center gap-0.5 pr-1">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={!collapsed}
				title={title}
				className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-muted text-xs hover:text-fg"
			>
				<ChevronRight className={cn("size-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")} />
				{icon}
				<span className="truncate font-medium">{label}</span>
			</button>
			{actions && (
				<div className="flex shrink-0 items-center opacity-100 transition md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
					{actions}
				</div>
			)}
		</div>
	);
}

function ProjectMenu({ project }: { project: ProjectInfo }) {
	const menu = useMenuAnchor();
	return (
		<>
			<IconButton label="Project options" onClick={menu.toggle} className="p-1">
				<Ellipsis className="size-3.5" />
			</IconButton>
			{menu.anchor && (
				<Menu
					anchor={menu.anchor}
					align="end"
					onClose={menu.close}
					items={[
						{ kind: "header", label: project.path },
						{
							label: "Rename",
							icon: <Pencil className="size-4" />,
							onSelect: () => {
								const name = window.prompt("Project name", project.name)?.trim();
								if (name && name !== project.name) void attempt(() => client.updateProject(project.id, { name }));
							},
						},
						{
							label: "Remove project",
							icon: <Trash2 className="size-4" />,
							danger: true,
							onSelect: () => {
								if (window.confirm(`Remove “${project.name}”? Its folder on disk is left untouched.`))
									void attempt(() => client.deleteProject(project.id));
							},
						},
					]}
				/>
			)}
		</>
	);
}

export function Sidebar({ activeId, onNavigate, onHide, mobile }: Props) {
	const ui = useUi();
	const state = useServerState();
	const connection = useConnection();
	const { isCollapsed, toggle } = useCollapsed();
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [moving, setMoving] = useState<SessionInfo | null>(null);

	const groups = useMemo(() => {
		const sessions = state?.sessions ?? [];
		const projects = state?.projects ?? [];
		const projectIds = new Set(projects.map((project) => project.id));
		const live = sessions.filter((session) => !session.archived).sort(byRecent);
		const byProject = new Map<string, SessionInfo[]>();
		const chats: SessionInfo[] = [];
		for (const session of live) {
			if (session.pinned) continue;
			if (session.projectId && projectIds.has(session.projectId)) {
				const list = byProject.get(session.projectId) ?? [];
				list.push(session);
				byProject.set(session.projectId, list);
			} else {
				chats.push(session);
			}
		}
		const recency = (project: ProjectInfo) =>
			Math.max(project.createdAt, byProject.get(project.id)?.[0]?.updatedAt ?? 0);
		return {
			pinned: live.filter((session) => session.pinned),
			projects: [...projects].sort((a, b) => recency(b) - recency(a)),
			byProject,
			chats,
			archived: sessions.filter((session) => session.archived).sort(byRecent),
		};
	}, [state?.sessions, state?.projects]);

	const onMove = useCallback((session: SessionInfo) => setMoving(session), []);

	const rows = (list: SessionInfo[]) =>
		list.map((session) => (
			<SessionRow
				key={session.id}
				session={session}
				active={session.id === activeId}
				onNavigate={onNavigate}
				onMove={onMove}
			/>
		));

	const newChat = (projectId?: string | null) => {
		ui.newChat(projectId);
		onNavigate();
	};

	return (
		<aside className="pt-safe flex h-full w-full flex-col bg-sidebar">
			<div className="flex h-12 shrink-0 items-center justify-between pr-2 pl-4">
				<button
					type="button"
					onClick={() => newChat()}
					className="font-semibold font-serif text-fg text-lg tracking-tight"
				>
					Tiny
				</button>
				<IconButton label={mobile ? "Close sidebar" : "Collapse sidebar"} onClick={onHide}>
					{mobile ? <X className="size-5" /> : <PanelLeftClose className="size-5" />}
				</IconButton>
			</div>

			<nav className="shrink-0 space-y-0.5 px-2 pb-2">
				<NavButton icon={<SquarePen className="size-4" />} label="New chat" onClick={() => newChat()} />
				<NavButton icon={<Search className="size-4" />} label="Search" hint="⌘K" onClick={ui.openSearch} />
				<NavButton icon={<Workflow className="size-4" />} label="Workflows" onClick={() => ui.openWorkflows()} />
			</nav>

			<div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-4">
				{groups.pinned.length > 0 && (
					<section>
						<GroupHeader label="Pinned" collapsed={isCollapsed("pinned")} onToggle={() => toggle("pinned")} />
						{!isCollapsed("pinned") && <div className="space-y-px">{rows(groups.pinned)}</div>}
					</section>
				)}

				<section>
					<div className="flex items-center justify-between pr-1 pl-2.5">
						<span className="py-1.5 font-medium text-faint text-xs">Projects</span>
						<IconButton label="Add project" onClick={ui.openAddProject} className="p-1">
							<FolderPlus className="size-3.5" />
						</IconButton>
					</div>
					{groups.projects.length === 0 && (
						<button
							type="button"
							onClick={ui.openAddProject}
							className="w-full rounded-lg px-2.5 py-2 text-left text-faint text-xs hover:bg-surface-2/70 hover:text-muted"
						>
							Add a folder as a project to work in it.
						</button>
					)}
					<div className="space-y-1">
						{groups.projects.map((project) => {
							const id = `p:${project.id}`;
							const collapsed = isCollapsed(id);
							const sessions = groups.byProject.get(project.id) ?? [];
							const showAll = expanded[id] ?? false;
							const visible = showAll ? sessions : sessions.slice(0, PROJECT_PREVIEW);
							return (
								<div key={project.id}>
									<GroupHeader
										label={project.name}
										title={project.path}
										icon={
											collapsed ? (
												<Folder className="size-3.5 shrink-0" />
											) : (
												<FolderOpen className="size-3.5 shrink-0" />
											)
										}
										collapsed={collapsed}
										onToggle={() => toggle(id)}
										actions={
											<>
												<IconButton
													label={`New chat in ${project.name}`}
													onClick={() => newChat(project.id)}
													className="p-1"
												>
													<Plus className="size-3.5" />
												</IconButton>
												<ProjectMenu project={project} />
											</>
										}
									/>
									{!collapsed && (
										<div className="ml-3 space-y-px border-border border-l pl-1">
											{visible.length === 0 && <div className="px-2.5 py-1 text-faint text-xs">No chats yet</div>}
											{rows(visible)}
											{sessions.length > PROJECT_PREVIEW && (
												<button
													type="button"
													onClick={() => setExpanded((value) => ({ ...value, [id]: !showAll }))}
													className="w-full rounded-lg px-2.5 py-1 text-left text-faint text-xs hover:text-fg"
												>
													{showAll ? "Show less" : `Show ${sessions.length - PROJECT_PREVIEW} more`}
												</button>
											)}
										</div>
									)}
								</div>
							);
						})}
					</div>
				</section>

				<section>
					<GroupHeader
						label="Chats"
						collapsed={isCollapsed("chats")}
						onToggle={() => toggle("chats")}
						actions={
							<IconButton label="New chat without a project" onClick={() => newChat(null)} className="p-1">
								<Plus className="size-3.5" />
							</IconButton>
						}
					/>
					{!isCollapsed("chats") && (
						<div className="space-y-px">
							{groups.chats.length === 0 && <div className="px-2.5 py-1 text-faint text-xs">No chats yet</div>}
							{rows(groups.chats)}
						</div>
					)}
				</section>

				{groups.archived.length > 0 && (
					<section>
						<GroupHeader
							label={`Archived (${groups.archived.length})`}
							collapsed={isCollapsed("archived")}
							onToggle={() => toggle("archived")}
						/>
						{!isCollapsed("archived") && <div className="space-y-px opacity-80">{rows(groups.archived)}</div>}
					</section>
				)}
			</div>

			<div className="pb-safe shrink-0 border-border/70 border-t">
				<div className="flex items-center gap-2 px-4 py-2.5 text-faint text-xs">
					<span
						className={cn(
							"size-2 rounded-full",
							connection === "open"
								? "bg-success"
								: connection === "connecting"
									? "animate-pulse bg-warn"
									: "bg-danger",
						)}
					/>
					<span>{connection === "open" ? "Connected" : connection === "connecting" ? "Connecting…" : "Offline"}</span>
					{state?.version && <span className="ml-auto">v{state.version}</span>}
				</div>
			</div>

			{moving && (
				<MoveDialog
					session={moving}
					projects={state?.projects ?? []}
					onClose={() => setMoving(null)}
					onAddProject={ui.openAddProject}
				/>
			)}
		</aside>
	);
}
