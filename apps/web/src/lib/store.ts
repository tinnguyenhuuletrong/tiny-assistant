import type { ConnectionStatus, ServerState, SessionView } from "@tiny/core";
import { useSyncExternalStore } from "react";
import { client } from "./client.ts";

const subscribe = (listener: () => void) => client.subscribe(listener);

/** The server state; a new object only when sessions, projects, or the registry change. */
export function useServerState(): ServerState | undefined {
	return useSyncExternalStore(subscribe, () => client.state);
}

export function useConnection(): ConnectionStatus {
	return useSyncExternalStore(subscribe, () => client.status);
}

/** A followed session's view; a new object after every applied op batch. */
export function useSessionView(sessionId: number): SessionView | undefined {
	return useSyncExternalStore(subscribe, () => client.views.get(sessionId));
}
