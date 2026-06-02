# Peer Types

Nine peer types are recognized by the registry. Each has different delivery behavior.

## Taxonomy

| Peer type | agentId prefix | Delivery mode | Requires daemon |
|---|---|---|---|
| `claude-code` | `client-claude-code-*` | Push via MCP notification | No |
| `opencode-code` | `client-opencode-*` | Push via `session.prompt_async` | Plugin required |
| `opencode-bridge` | `client-opencode-bridge-*` | Push via `session.prompt_async` | Plugin (runs inside OpenCode) |
| `codex-bridge` | `client-codex-bridge-*` | Inject via `turn/start` JSON-RPC | Yes — `codex app-bridge` |
| `codex-inner` | `client-codex-mcp-client-*` | Pull — must call `channel_inbox` | No (passive) |
| `gemini-bridge` | `client-codex-bridge-*` (acp) | Inject via `session/prompt` JSON-RPC | Yes — `gemini app-bridge` |
| `gemini-inner` | `client-gemini-mcp-client-*` | Pull — must call `channel_inbox` | No (passive) |
| `dashboard-ui` | `client-dashboard-ui-*` | WS event in chat panel | No |
| `unknown` | any unrecognized | Passive | Depends |

## Notes

**Claude Code** receives messages as `<channel>` blocks in the terminal via `notifications/claude/channel`. Up to 100 messages are buffered before the `initialize` handshake.

**OpenCode** has two registrations per session: the MCP client (`opencode-code`) and the plugin bridge (`opencode-bridge`). The adapter routes to the plugin bridge automatically when it is present. The MCP client can still call `channel_inbox` and `reply`.

**Codex** always has two registrations: the bridge daemon (`codex-bridge`) and an inner MCP client (`codex-inner`). Sending to either agentId routes to the bridge. A plain `codex` session (no `--remote`) only registers the inner MCP client — it cannot receive automatic turn injection.

**Gemini** follows the same pattern as Codex: ACP bridge daemon + inner MCP client. Auto-approve of `session/request_permission` is done by the bridge.

**Dashboard** is a passive listener. Never set it as the target of a `message_client_session` call.

## How to identify the peer type from `list_agents`

`list_agents(includeClients: true)` returns rows like:

```
[OpenCode]        my-project  [a1b2c3d4]
[OpenCode bridge] my-project  [e5f6a7b8]
[Codex inner]     other-proj  [c9d0e1f2]
[Claude Code]     another     [f3a4b5c6]
```

The bracket label is the human-readable peer type. The 8-char suffix is the last 8 chars of the agentId for disambiguation when multiple same-type sessions are visible.
