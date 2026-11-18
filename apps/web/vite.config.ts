import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The daemon the dev server proxies to. In production the daemon serves `dist/` itself. */
const daemon = "http://127.0.0.1:7777";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		proxy: {
			"/api": { target: daemon },
			"/ws": { target: daemon, ws: true },
		},
	},
	build: {
		outDir: "dist",
		target: "es2022",
		chunkSizeWarningLimit: 1500,
	},
});
