agent-bridge Codex bootstrap

Read `../PROJECT_MAP.md` first. It is the canonical quick-memory map for this repository.

This `.codex/` directory serves two roles:

- native Codex project configuration
- repo-local bootstrap notes for Codex workflows

Critical hotspots:

- `src/registry/server.ts`: central registry, channel persistence and WS events
- `src/agent/server.ts`: agent runtime, A2A/JSON-RPC, AG-UI SSE
- `src/agent/handlers.ts`: task routing and task lifecycle
- `src/mcp/adapter.ts`: MCP bridge and channel tools
- `src/client/codex-tmux-bridge-service.ts`: tmux sidecar for Codex follow-up injection
- `src/client/codex-session-files.ts`: current Codex session marker and tmux binding

Current reality:

- local-first system on `localhost`
- registry agent state is in memory; channel conversations persist in `.agent-bridge/registry.sqlite`
- Codex uses `channels` as transport + persistence, not as native push activation
- Codex-to-Codex collaboration now works best with a tmux-backed sidecar bound to the active Codex pane
