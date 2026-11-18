import { createContext, useContext } from "react";

export type WorkflowDialogOptions = {
	name?: string;
	/** JSON input text to prefill. */
	input?: string;
	projectId?: string | null;
	/** Offer to run inside this chat instead of a new one. */
	sessionId?: number;
};

/** App-level actions any component may trigger (dialogs, sidebar, navigation helpers). */
export type UiActions = {
	showSidebar: () => void;
	openSearch: () => void;
	openWorkflows: (options?: WorkflowDialogOptions) => void;
	openAddProject: () => void;
	/** Go to the new chat screen, optionally preselecting a project (`null` = no project). */
	newChat: (projectId?: string | null) => void;
};

export const UiContext = createContext<UiActions | null>(null);

export function useUi(): UiActions {
	const ui = useContext(UiContext);
	if (!ui) throw new Error("useUi outside UiContext");
	return ui;
}
