import { useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(listener) => {
			const list = window.matchMedia(query);
			list.addEventListener("change", listener);
			return () => list.removeEventListener("change", listener);
		},
		() => window.matchMedia(query).matches,
	);
}

/** Desktop layout: persistent sidebar. */
export const useIsDesktop = () => useMediaQuery("(min-width: 768px)");

/** Touch-first devices: Enter inserts a newline, the Send button submits. */
export const useCoarsePointer = () => useMediaQuery("(pointer: coarse)");
