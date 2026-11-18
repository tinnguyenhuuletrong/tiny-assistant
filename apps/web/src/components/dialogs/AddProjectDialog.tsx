import type { DirListing, ProjectInfo } from "@tiny/core";
import { ChevronRight, CornerLeftUp, Folder, FolderPlus, HardDrive } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../lib/client.ts";
import { basename, cn } from "../../lib/format.ts";
import { useServerState } from "../../lib/store.ts";
import { attempt } from "../../lib/toast.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Spinner } from "../ui/Spinner.tsx";

function separatorOf(path: string): string {
	return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function joinPath(dir: string, name: string): string {
	const sep = separatorOf(dir);
	return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Breadcrumb segments with the path each one opens. */
function crumbs(path: string): { label: string; path: string }[] {
	const sep = separatorOf(path);
	const parts = path.split(sep).filter(Boolean);
	const out: { label: string; path: string }[] = [];
	const absolute = path.startsWith(sep);
	if (absolute) out.push({ label: sep, path: sep });
	let current = absolute ? "" : "";
	for (const [index, part] of parts.entries()) {
		current = index === 0 && !absolute ? part : `${current}${sep}${part}`;
		out.push({ label: part, path: index === 0 && !absolute ? `${part}${sep}` : current });
	}
	return out;
}

/** Browse the daemon's filesystem and register a folder as a project. */
export function AddProjectDialog({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (project: ProjectInfo) => void;
}) {
	const state = useServerState();
	const [listing, setListing] = useState<DirListing | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [filter, setFilter] = useState("");
	const [showHidden, setShowHidden] = useState(false);
	const [newFolder, setNewFolder] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const open = useCallback(async (path?: string) => {
		setLoading(true);
		setError(null);
		try {
			const next = await client.listDir(path);
			setListing(next);
			setName(basename(next.path));
			setFilter("");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void open();
	}, [open]);

	const dirs = useMemo(() => {
		const query = filter.trim().toLowerCase();
		return (listing?.dirs ?? []).filter(
			(dir) => (showHidden || !dir.name.startsWith(".")) && (!query || dir.name.toLowerCase().includes(query)),
		);
	}, [listing, filter, showHidden]);

	const existing = listing ? state?.projects.find((project) => project.path === listing.path) : undefined;

	const create = async (path: string, projectName: string, createFolder: boolean) => {
		setBusy(true);
		const project = await attempt(() =>
			client.createProject({ path, name: projectName.trim() || basename(path), create: createFolder || undefined }),
		);
		setBusy(false);
		if (project) onCreated(project);
	};

	return (
		<Dialog
			title="Add project"
			onClose={onClose}
			className="md:max-w-xl"
			footer={
				listing && (
					<div className="flex flex-col gap-2.5">
						{existing ? (
							<p className="text-muted text-xs">
								This folder is already the project <span className="font-medium text-fg">{existing.name}</span>.
							</p>
						) : (
							<label className="flex items-center gap-2 text-sm">
								<span className="shrink-0 text-muted">Name</span>
								<input
									value={name}
									onChange={(event) => setName(event.target.value)}
									className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-base outline-none focus:border-border-strong md:text-sm"
								/>
							</label>
						)}
						<div className="flex items-center gap-2">
							<Button variant="ghost" onClick={() => setNewFolder(newFolder === null ? "" : null)}>
								<FolderPlus className="size-4" /> New folder
							</Button>
							<div className="flex-1" />
							<Button variant="secondary" onClick={onClose}>
								Cancel
							</Button>
							{existing ? (
								<Button variant="primary" onClick={() => onCreated(existing)}>
									Open
								</Button>
							) : (
								<Button variant="primary" disabled={busy} onClick={() => void create(listing.path, name, false)}>
									{busy && <Spinner className="size-3.5" />} Use this folder
								</Button>
							)}
						</div>
					</div>
				)
			}
		>
			<div className="flex flex-col">
				{listing && (
					<div className="sticky top-0 z-10 space-y-2 border-border border-b bg-surface px-4 py-3">
						{listing.roots.length > 1 && (
							<div className="flex flex-wrap gap-1.5">
								{listing.roots.map((root) => (
									<button
										key={root}
										type="button"
										onClick={() => void open(root)}
										className={cn(
											"inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs",
											listing.path.startsWith(root) ? "border-border-strong text-fg" : "border-border text-muted",
										)}
									>
										<HardDrive className="size-3" /> {root}
									</button>
								))}
							</div>
						)}
						<div className="scrollbar-thin flex items-center gap-0.5 overflow-x-auto whitespace-nowrap text-sm">
							{crumbs(listing.path).map((crumb, index, all) => (
								<span key={crumb.path} className="inline-flex items-center">
									{index > 0 && index > (all[0]?.label === "/" ? 1 : 0) && (
										<ChevronRight className="size-3.5 shrink-0 text-faint" />
									)}
									<button
										type="button"
										onClick={() => void open(crumb.path)}
										className={cn(
											"rounded px-1 py-0.5 hover:bg-surface-2",
											index === all.length - 1 ? "font-medium text-fg" : "text-muted",
										)}
									>
										{crumb.label}
									</button>
								</span>
							))}
						</div>
						<div className="flex items-center gap-2">
							<input
								value={filter}
								onChange={(event) => setFilter(event.target.value)}
								placeholder="Filter folders"
								className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-base outline-none focus:border-border-strong md:text-sm"
							/>
							<label className="flex shrink-0 items-center gap-1.5 text-muted text-xs">
								<input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
								Hidden
							</label>
						</div>
						{newFolder !== null && (
							<form
								className="flex items-center gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									const folder = newFolder.trim();
									if (folder) void create(joinPath(listing.path, folder), folder, true);
								}}
							>
								<input
									autoFocus
									value={newFolder}
									onChange={(event) => setNewFolder(event.target.value)}
									placeholder="New folder name"
									className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-base outline-none focus:border-border-strong md:text-sm"
								/>
								<Button type="submit" variant="primary" disabled={!newFolder.trim() || busy}>
									Create project
								</Button>
							</form>
						)}
					</div>
				)}
				<div className="min-h-64 p-2">
					{loading && !listing && (
						<div className="flex justify-center py-10 text-muted">
							<Spinner className="size-5" />
						</div>
					)}
					{error && <p className="px-3 py-4 text-danger text-sm">{error}</p>}
					{listing && (
						<div className={cn("transition-opacity", loading && "opacity-50")}>
							{listing.parent && (
								<button
									type="button"
									onClick={() => void open(listing.parent ?? undefined)}
									className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-muted text-sm hover:bg-surface-2"
								>
									<CornerLeftUp className="size-4" /> ..
								</button>
							)}
							{dirs.map((dir) => (
								<button
									key={dir.path}
									type="button"
									onClick={() => void open(dir.path)}
									className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2"
								>
									<Folder className={cn("size-4 shrink-0", dir.isProject ? "text-accent" : "text-muted")} />
									<span className="min-w-0 flex-1 truncate">{dir.name}</span>
									{dir.isProject && (
										<span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
											project
										</span>
									)}
									<ChevronRight className="size-4 shrink-0 text-faint" />
								</button>
							))}
							{dirs.length === 0 && !loading && (
								<p className="px-3 py-6 text-center text-faint text-sm">
									{filter ? "No matching folders" : "No folders here"}
								</p>
							)}
						</div>
					)}
				</div>
			</div>
		</Dialog>
	);
}
