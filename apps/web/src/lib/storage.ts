/** localStorage helpers that never throw (private mode, disabled storage, quota). */
export function load<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}

export function save(key: string, value: unknown): void {
	try {
		if (value === undefined || value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage unavailable: the app still works, it just forgets.
	}
}

export const KEYS = {
	token: "tiny.token",
	lastSession: "tiny.lastSession",
	sidebarCollapsed: "tiny.sidebarCollapsed",
	collapsedGroups: "tiny.collapsedGroups",
	lastProject: "tiny.lastProject",
	draft: (scope: string) => `tiny.draft.${scope}`,
} as const;
