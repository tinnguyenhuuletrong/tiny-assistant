import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { client } from "./lib/client.ts";
import { KEYS, load } from "./lib/storage.ts";

// Reopen the last chat when the app starts without a route (e.g. launched from the home screen).
if (!location.hash || location.hash === "#" || location.hash === "#/") {
	const last = load<number | null>(KEYS.lastSession, null);
	if (typeof last === "number") history.replaceState(null, "", `#/s/${last}`);
}

client.connect();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
