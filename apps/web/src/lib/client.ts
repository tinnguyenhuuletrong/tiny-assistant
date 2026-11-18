import { AssistantClient } from "@tiny/core";
import { KEYS, load, save } from "./storage.ts";

/**
 * A daemon that requires a token can be opened once as `/?token=…`; the token is remembered and dropped from the URL.
 */
function initialToken(): string | undefined {
	try {
		const url = new URL(location.href);
		const fromUrl = url.searchParams.get("token");
		if (fromUrl) {
			save(KEYS.token, fromUrl);
			url.searchParams.delete("token");
			history.replaceState(null, "", url.toString());
			return fromUrl;
		}
	} catch {
		// Fall through to the stored token.
	}
	return load<string | null>(KEYS.token, null) ?? undefined;
}

export const client = new AssistantClient({ client: "web", name: "web", token: initialToken() });

export function setToken(token: string): void {
	save(KEYS.token, token);
	location.reload();
}
