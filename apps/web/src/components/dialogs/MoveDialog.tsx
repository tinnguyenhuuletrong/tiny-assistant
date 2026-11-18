import type { ProjectInfo, SessionInfo } from "@tiny/core";
import { Check, Folder, FolderPlus, MessageSquare } from "lucide-react";
import { client } from "../../lib/client.ts";
import { attempt } from "../../lib/toast.ts";
import { Dialog } from "../ui/Dialog.tsx";

export function MoveDialog({
	session,
	projects,
	onClose,
	onAddProject,
}: {
	session: SessionInfo;
	projects: readonly ProjectInfo[];
	onClose: () => void;
	onAddProject: () => void;
}) {
	const move = async (projectId: string | null) => {
		onClose();
		if (projectId !== session.projectId) await attempt(() => client.updateSession(session.id, { projectId }));
	};
	const row = (key: string, label: string, sub: string | null, icon: React.ReactNode, projectId: string | null) => (
		<button
			key={key}
			type="button"
			onClick={() => void move(projectId)}
			className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-surface-2"
		>
			<span className="text-muted">{icon}</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate">{label}</span>
				{sub && <span className="block truncate text-faint text-xs">{sub}</span>}
			</span>
			{session.projectId === projectId && <Check className="size-4 text-accent" />}
		</button>
	);
	return (
		<Dialog title={`Move “${session.title || "chat"}”`} onClose={onClose}>
			<div className="p-2">
				{row("none", "No project", "A plain chat", <MessageSquare className="size-4" />, null)}
				{projects.map((project) =>
					row(project.id, project.name, project.path, <Folder className="size-4" />, project.id),
				)}
				<button
					type="button"
					onClick={() => {
						onClose();
						onAddProject();
					}}
					className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-muted text-sm hover:bg-surface-2 hover:text-fg"
				>
					<FolderPlus className="size-4" /> Add project…
				</button>
			</div>
		</Dialog>
	);
}
