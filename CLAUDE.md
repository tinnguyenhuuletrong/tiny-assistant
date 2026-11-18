# tiny-assistant: notes for coding agents

- **Bun only** (`bun install`, `bun test`, `bun run`). Never npm/pnpm/yarn.
- `make check` must pass before committing: it formats (Biome), then lints, runs `tsc` in every package, and
  `bun test`. `make ci` runs the same checks without changing files.
- Layout:
  - `packages/core`: browser-safe protocol types (`protocol.ts`), the display model (`display.ts`), the one API client
    (`client.ts`), and the tool/workflow authoring API (`define.ts`, server-side only).
  - `apps/server`: the daemon. `service.ts` owns the pi-durable Harness, sessions, live feeds, indexing;
    `server.ts` is REST + WebSocket; `workflows.ts` is the workflow engine (one durable task per run, steps memoized
    with `runtime.memo`); `loader.ts` hot-reloads `assistant/`.
  - `apps/web`: React + Vite + Tailwind client. `apps/tui`: pi-tui client.
  - `assistant/`: user tools and workflows (examples).
- Every client change to the API goes through `protocol.ts` + `client.ts` first, so the web app and the TUI stay in
  sync. Live state is the pi-durable conversation view, forwarded as Chord delta ops; don't invent parallel state.
- Server tests use pi-ai's faux provider (`apps/server/test/helpers.ts`), so they cost nothing and need no login.
- Don't call real models in tests. For a manual end-to-end check against a running daemon: `bun scripts/smoke.ts`.
