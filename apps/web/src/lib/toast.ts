import { useSyncExternalStore } from "react";

export type Toast = { id: number; text: string; level: "error" | "info" };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function toast(text: string, level: Toast["level"] = "error"): void {
	const id = nextId++;
	toasts = [...toasts.filter((item) => item.text !== text), { id, text, level }].slice(-4);
	emit();
	setTimeout(() => dismissToast(id), level === "error" ? 6000 : 3000);
}

export function dismissToast(id: number): void {
	toasts = toasts.filter((item) => item.id !== id);
	emit();
}

/** Run an action and toast its failure instead of throwing. */
export async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
	try {
		return await action();
	} catch (error) {
		toast(error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

export function useToasts(): Toast[] {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => toasts,
	);
}
