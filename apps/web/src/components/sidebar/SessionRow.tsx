import type { SessionInfo } from "@tiny/core";
import { Archive, ArchiveRestore, Ellipsis, FolderInput, Pencil, Pin, PinOff, Trash2, Workflow } from "lucide-react";
import { memo, useState } from "react";
import { client } from "../../lib/client.ts";
import { cn } from "../../lib/format.ts";
import { hrefFor, navigate } from "../../lib/router.ts";
import { attempt } from "../../lib/toast.ts";
import { Menu, useMenuAnchor } from "../ui/Menu.tsx";
import { Spinner } from "../ui/Spinner.tsx";

type Props = {
	session: SessionInfo;
	active: boolean;
	onNavigate: () => void;
	onMove: (session: SessionInfo) => void;
};

export const SessionRow = memo(function SessionRow({ session, active, onNavigate, onMove }: Props) {
	const [renaming, setRenaming] = useState(false);
	const menu = useMenuAnchor();
	const title = session.title || session.preview || "New chat";

	const commitRename = (value: string) => {
		setRenaming(false);
		const next = value.trim();
		if (next && next !== session.title) void attempt(() => client.updateSession(session.id, { title: next }));
	};

	const remove = () => {
		if (!window.confirm(`Delete “${title}”? This cannot be undone.`)) return;
		void attempt(async () => {
			await client.deleteSession(session.id);
			if (active) navigate({ name: "home" }, { replace: true });
		});
	};

	return (
		<div
			className={cn(
				"group relative flex items-center rounded-lg text-sm transition",
				active ? "bg-surface-2 text-fg" : "text-fg/85 hover:bg-surface-2/70",
			)}
		>
			{renaming ? (
				<input
					// biome-ignore lint/a11y/noAutofocus: the user just asked to rename
					autoFocus
					defaultValue={session.title}
					onFocus={(event) => event.currentTarget.select()}
					onBlur={(event) => commitRename(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") commitRename(event.currentTarget.value);
						if (event.key === "Escape") setRenaming(false);
					}}
					className="mx-1 my-0.5 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 py-1 text-base outline-none md:text-sm"
				/>
			) : (
				<a
					href={hrefFor({ name: "session", id: session.id })}
					onClick={onNavigate}
					className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-2.5"
					title={title}
				>
					{session.workflow && <Workflow className="size-3.5 shrink-0 text-faint" />}
					<span className="truncate">{title}</span>
				</a>
			)}
			{session.busy && !renaming && (
				<span className="flex shrink-0 items-center px-1" title="Working">
					<Spinner className="size-3.5 text-accent" />
				</span>
			)}
			{!renaming && (
				<button
					type="button"
					aria-label="Chat options"
					onClick={menu.toggle}
					className={cn(
						"mr-1 shrink-0 rounded-md p-1 text-muted transition hover:bg-border/60 hover:text-fg",
						menu.anchor ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100 hover-none:opacity-100",
					)}
				>
					<Ellipsis className="size-4" />
				</button>
			)}
			{menu.anchor && (
				<Menu
					anchor={menu.anchor}
					align="end"
					onClose={menu.close}
					items={[
						{ label: "Rename", icon: <Pencil className="size-4" />, onSelect: () => setRenaming(true) },
						{
							label: session.pinned ? "Unpin" : "Pin",
							icon: session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
							onSelect: () => void attempt(() => client.updateSession(session.id, { pinned: !session.pinned })),
						},
						{ label: "Move to project…", icon: <FolderInput className="size-4" />, onSelect: () => onMove(session) },
						{
							label: session.archived ? "Unarchive" : "Archive",
							icon: session.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />,
							onSelect: () => void attempt(() => client.updateSession(session.id, { archived: !session.archived })),
						},
						{ kind: "separator" },
						{ label: "Delete", icon: <Trash2 className="size-4" />, danger: true, onSelect: remove },
					]}
				/>
			)}
		</div>
	);
});
