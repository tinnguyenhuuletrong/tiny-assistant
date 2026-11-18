.DEFAULT_GOAL := help
.PHONY: help install dev start tui build bundle check lint format fix typecheck test tailscale-serve tailscale-off service-install service-uninstall service-status logs

help: ## show targets
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## install dependencies
	bun install

dev: ## daemon (watch) + web (vite on :5173)
	bun run dev

start: build ## build the web app and run the daemon
	bun run start

tui: ## terminal client (URL=http://host:7777 for a remote daemon)
	bun apps/tui/src/main.ts $(URL)

build: ## build the web app
	bun run web:build

bundle: ## single-file TUI in dist/tiny-tui.js
	bun run tui:bundle

check: lint typecheck test ## lint + typecheck + tests (run before every commit)

lint: ## biome lint + format check
	bunx biome check .

format: ## biome format
	bunx biome format --write .

fix: ## biome safe fixes + format
	bunx biome check --write .

typecheck: ## tsc in every package
	bun run typecheck

test: ## bun test
	bun test

tailscale-serve: ## HTTPS on your tailnet -> local daemon
	tailscale serve --bg $${TINY_PORT:-7777}

tailscale-off: ## stop tailscale serve
	tailscale serve reset

service-install: build ## run the daemon at login (macOS launchd)
	bun scripts/launchd.ts install

service-uninstall: ## remove the launchd service
	bun scripts/launchd.ts uninstall

service-status: ## launchd status
	bun scripts/launchd.ts status

logs: ## follow daemon logs (launchd)
	tail -f ~/.tiny-assistant/logs/daemon.log
