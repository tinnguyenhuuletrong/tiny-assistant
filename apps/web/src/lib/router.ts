import { useSyncExternalStore } from "react";

/** Hash routing (`#/`, `#/s/:id`), so the daemon can serve the build as plain static files. */
export type Route = { name: "home" } | { name: "session"; id: number };

function parse(hash: string): Route {
	const match = /^#\/s\/(\d+)/.exec(hash);
	return match ? { name: "session", id: Number(match[1]) } : { name: "home" };
}

let current: Route = parse(location.hash);
let currentHash = location.hash;

function snapshot(): Route {
	if (location.hash !== currentHash) {
		currentHash = location.hash;
		current = parse(currentHash);
	}
	return current;
}

function subscribe(listener: () => void): () => void {
	window.addEventListener("hashchange", listener);
	return () => window.removeEventListener("hashchange", listener);
}

export function useRoute(): Route {
	return useSyncExternalStore(subscribe, snapshot);
}

export function hrefFor(route: Route): string {
	return route.name === "session" ? `#/s/${route.id}` : "#/";
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
	const href = hrefFor(route);
	if (location.hash === href) return;
	if (options.replace) {
		history.replaceState(null, "", href);
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	} else {
		location.hash = href;
	}
}
