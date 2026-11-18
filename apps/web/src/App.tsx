import { ApiError } from "@tiny/core";
import { CircleAlert, PanelLeft, Search, SquarePen, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ChatView } from "./components/chat/ChatView.tsx";
import { NewChat } from "./components/chat/NewChat.tsx";
import { AddProjectDialog } from "./components/dialogs/AddProjectDialog.tsx";
import { SearchDialog } from "./components/dialogs/SearchDialog.tsx";
import { WorkflowDialog } from "./components/dialogs/WorkflowDialog.tsx";
import { Sidebar } from "./components/sidebar/Sidebar.tsx";
import { Button, IconButton } from "./components/ui/Button.tsx";
import { Spinner } from "./components/ui/Spinner.tsx";
import { Toasts } from "./components/ui/Toasts.tsx";
import { client, setToken } from "./lib/client.ts";
import { cn } from "./lib/format.ts";
import { useIsDesktop } from "./lib/media.ts";
import { navigate, useRoute } from "./lib/router.ts";
import { KEYS, load, save } from "./lib/storage.ts";
import { useServerState } from "./lib/store.ts";
import { toast } from "./lib/toast.ts";
import { type UiActions, UiContext, type WorkflowDialogOptions } from "./lib/ui.ts";

type DialogState =
	| { kind: "search" }
	| { kind: "workflow"; options: WorkflowDialogOptions }
	| { kind: "addProject" }
	| null;

type BootError = { message: string; unauthorized: boolean };

function useBoot(): BootError | null {
	const [error, setError] = useState<BootError | null>(null);
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const attemptLoad = async (attempt: number) => {
			try {
				await client.loadState();
				if (!cancelled) setError(null);
			} catch (failure) {
				if (cancelled) return;
				const unauthorized = failure instanceof ApiError && failure.status === 401;
				setError({ message: failure instanceof Error ? failure.message : String(failure), unauthorized });
				// The socket may still deliver state; keep retrying unless we need a token.
				if (!unauthorized) timer = setTimeout(() => attemptLoad(attempt + 1), Math.min(10_000, 1000 * 2 ** attempt));
			}
		};
		void attemptLoad(0);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, []);
	return error;
}

function BootScreen({ error }: { error: BootError | null }) {
	const [token, setTokenInput] = useState("");
	return (
		<div className="pt-safe flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
			{!error ? (
				<Spinner className="size-6 text-muted" />
			) : error.unauthorized ? (
				<form
					className="flex w-full max-w-sm flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						if (token.trim()) setToken(token.trim());
					}}
				>
					<h1 className="font-semibold text-lg">Sign in</h1>
					<p className="text-muted text-sm">This assistant requires an access token.</p>
					<input
						type="password"
						value={token}
						onChange={(event) => setTokenInput(event.target.value)}
						placeholder="Token"
						autoComplete="current-password"
						className="rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-border-strong"
					/>
					<Button type="submit" variant="primary" disabled={!token.trim()}>
						Continue
					</Button>
				</form>
			) : (
				<>
					<CircleAlert className="size-7 text-danger" />
					<div>
						<h1 className="font-semibold text-lg">Can't reach the assistant</h1>
						<p className="mt-1 text-muted text-sm">{error.message}</p>
					</div>
					<p className="flex items-center gap-2 text-faint text-xs">
						<Spinner className="size-3" /> Retrying…
					</p>
				</>
			)}
		</div>
	);
}

function Rail({ ui }: { ui: UiActions }) {
	return (
		<div className="pt-safe flex w-14 shrink-0 flex-col items-center gap-1 border-border/70 border-r bg-sidebar py-2">
			<IconButton label="Expand sidebar" onClick={ui.showSidebar} className="p-2">
				<PanelLeft className="size-5" />
			</IconButton>
			<IconButton label="New chat" onClick={() => ui.newChat()} className="p-2">
				<SquarePen className="size-5" />
			</IconButton>
			<IconButton label="Search" onClick={ui.openSearch} className="p-2">
				<Search className="size-5" />
			</IconButton>
			<IconButton label="Workflows" onClick={() => ui.openWorkflows()} className="p-2">
				<Workflow className="size-5" />
			</IconButton>
		</div>
	);
}

export function App() {
	const route = useRoute();
	const state = useServerState();
	const bootError = useBoot();
	const isDesktop = useIsDesktop();
	const [collapsed, setCollapsed] = useState(() => load(KEYS.sidebarCollapsed, false));
	const [drawer, setDrawer] = useState(false);
	const [dialog, setDialog] = useState<DialogState>(null);
	const [newChat, setNewChat] = useState<{ projectId?: string | null; nonce: number }>({ nonce: 0 });

	const sessionId = route.name === "session" ? route.id : null;

	useEffect(() => {
		save(KEYS.lastSession, sessionId);
		setDrawer(false);
	}, [sessionId]);

	useEffect(() => client.onError((message) => toast(message)), []);

	const ui = useMemo<UiActions>(() => {
		const setCollapsedSaved = (value: boolean) => {
			setCollapsed(value);
			save(KEYS.sidebarCollapsed, value);
		};
		const openDialog = (next: DialogState) => {
			setDrawer(false);
			setDialog(next);
		};
		return {
			showSidebar: () => (isDesktop ? setCollapsedSaved(false) : setDrawer(true)),
			openSearch: () => openDialog({ kind: "search" }),
			openWorkflows: (options = {}) => openDialog({ kind: "workflow", options }),
			openAddProject: () => openDialog({ kind: "addProject" }),
			newChat: (projectId) => {
				setNewChat((current) => ({ projectId, nonce: current.nonce + 1 }));
				setDrawer(false);
				navigate({ name: "home" });
			},
		};
	}, [isDesktop]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const mod = event.metaKey || event.ctrlKey;
			if (mod && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setDialog((current) => (current?.kind === "search" ? null : { kind: "search" }));
			} else if (mod && event.shiftKey && event.key.toLowerCase() === "o") {
				event.preventDefault();
				ui.newChat();
			} else if (mod && event.key === "\\") {
				event.preventDefault();
				setCollapsed((value) => {
					save(KEYS.sidebarCollapsed, !value);
					return !value;
				});
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [ui]);

	if (!state) {
		return (
			<>
				<BootScreen error={bootError} />
				<Toasts />
			</>
		);
	}

	const closeDialog = () => setDialog(null);
	const sidebar = (mobile: boolean) => (
		<Sidebar
			activeId={sessionId}
			mobile={mobile}
			onNavigate={() => setDrawer(false)}
			onHide={() => {
				if (mobile) setDrawer(false);
				else {
					setCollapsed(true);
					save(KEYS.sidebarCollapsed, true);
				}
			}}
		/>
	);

	return (
		<UiContext.Provider value={ui}>
			<div className="flex h-dvh overflow-hidden bg-bg text-fg">
				{isDesktop &&
					(collapsed ? (
						<Rail ui={ui} />
					) : (
						<div className="w-72 shrink-0 border-border/70 border-r">{sidebar(false)}</div>
					))}

				<main className="flex min-w-0 flex-1 flex-col">
					{sessionId !== null ? (
						<ChatView key={sessionId} sessionId={sessionId} />
					) : (
						<NewChat key={newChat.nonce} initialProject={newChat.projectId} />
					)}
				</main>

				{!isDesktop && (
					<div className={cn("fixed inset-0 z-50", !drawer && "pointer-events-none")} aria-hidden={!drawer}>
						<button
							type="button"
							aria-label="Close sidebar"
							tabIndex={-1}
							onClick={() => setDrawer(false)}
							className={cn(
								"absolute inset-0 bg-overlay transition-opacity duration-200",
								drawer ? "opacity-100" : "opacity-0",
							)}
						/>
						<div
							className={cn(
								"absolute inset-y-0 left-0 w-[85%] max-w-80 shadow-2xl transition-transform duration-200 ease-out",
								drawer ? "translate-x-0" : "-translate-x-full",
							)}
						>
							{sidebar(true)}
						</div>
					</div>
				)}
			</div>

			{dialog?.kind === "search" && <SearchDialog onClose={closeDialog} />}
			{dialog?.kind === "workflow" && (
				<WorkflowDialog options={dialog.options} onClose={closeDialog} onAddProject={ui.openAddProject} />
			)}
			{dialog?.kind === "addProject" && (
				<AddProjectDialog
					onClose={closeDialog}
					onCreated={(project) => {
						closeDialog();
						ui.newChat(project.id);
					}}
				/>
			)}
			<Toasts />
		</UiContext.Provider>
	);
}
