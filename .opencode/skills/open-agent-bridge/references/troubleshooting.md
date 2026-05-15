# Troubleshooting

## `delivered_to_bridge` — stuck, no progress

The bridge received the message but the client session never processed it.

**Codex:** The bridge daemon is running but no Codex TUI is attached. A plain `codex` session is isolated from the bridge's app-server.

Fix:
```bash
# Option A — let the bridge launch and attach Codex
open-agent-bridge codex start --project /path/to/project

# Option B — start bridge only, attach Codex manually
open-agent-bridge codex app-bridge --project /path/to/project
codex --remote ws://127.0.0.1:4500
```

**Gemini:** ACP bridge running but `gemini --acp` subprocess exited or stalled.

Fix:
```bash
open-agent-bridge gemini start --project /path/to/project
```

**OpenCode:** Plugin bridge running but `session.prompt_async` failed silently.

Check: Is OpenCode running? Did the plugin install succeed? Restart OpenCode.

**Claude Code:** The MCP adapter is running but the Claude terminal disconnected.

Check: Is Claude Code open and connected? `notifications/claude/channel` requires an active session.

---

## `displayed_to_client` — stuck at this state, no `answered`

The message was delivered but the recipient has not replied.

For Codex/Gemini: they received the injection as a turn but have not sent a reply channel message yet. Wait for the turn to complete, or check the Codex/Gemini terminal for errors.

For OpenCode: `session.prompt_async` was called but the session is idle or the model is not calling the `reply` tool. Check the OpenCode terminal.

For Claude Code: The `<channel>` block is visible in the terminal but the user has not asked Claude to reply. Prompt Claude to call `reply` with the `replyWith` fields.

---

## Registry not reachable

```
Error: fetch failed / ECONNREFUSED localhost:4999
```

The registry is not running.

Fix:
```bash
open-agent-bridge registry start
# or in auto mode (embedded registry):
open-agent-bridge mcp start
```

---

## `list_agents` returns empty or missing peers

The `AgentStore` is in-memory. After a registry restart, all registered agents must re-register. Bridges re-register automatically on reconnect. If a peer is missing, restart its bridge daemon.

---

## MCP tools not available in OpenCode

The MCP server entry is missing from the OpenCode MCP config. Generate and add it:

```bash
open-agent-bridge mcp config --write
```

Then restart OpenCode.

---

## OpenCode not receiving push messages (no auto-injection)

The plugin bridge is not installed or not running.

Install it:
```bash
open-agent-bridge opencode install-plugin --project /path/to/project
```

Then restart OpenCode. The plugin auto-loads from `.opencode/plugins/agent-bridge.ts` — no `opencode.json` edit needed.

---

## Codex inner client visible but messages not delivered

A Codex session started with plain `codex` (no `--remote`) registers an inner MCP client but the bridge cannot inject turns into it. The inner client can only pull via `channel_inbox`.

To get automatic injection: use `codex --remote ws://127.0.0.1:4500` against a running `codex app-bridge`.

---

## WS reconnect / registry restart

All bridge daemons implement exponential backoff with jitter on WS disconnect. They also run a periodic re-sync (every 5 minutes) that pulls missed messages from `/channel/conversations` and re-injects them. `BoundedIdSet(5000)` prevents duplicate injection on re-sync.

---

## Supercession (WS close code 4001)

When a new session registers with the same stable agentId hash, the registry closes the old WS connection with code 4001 (superceded). The old bridge daemon detects this and stops. The new session takes over the agentId.

This is expected behavior when restarting a bridge daemon while the registry is running.

---

## Dashboard shows wrong conversation attribution

Known bug: when a channel message is broadcast without a `toAgentId`, the dashboard chat panel cannot attribute it to the correct conversation. Workaround: always set `toAgentId` when sending targeted messages. Fix tracked in `src/registry/server.ts` broadcast relay.
