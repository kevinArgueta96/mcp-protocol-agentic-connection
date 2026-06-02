# Routing and Priority

## Target resolution in `message_client_session`

When you call `message_client_session`, the adapter resolves the best target in this order:

1. **`clientId` provided** — direct agentId lookup, no further resolution.
2. **No `clientId`, `conversationId` provided** — resolves from the conversation's participant history.
3. **`project` provided** — filters registered clients by project path/name substring.
4. **Multiple matches after filtering** — sorted by `CLIENT_PRIORITY`.

## CLIENT_PRIORITY array

```
Priority -1 (highest): bridge daemons
  clientVersion === "app-server-bridge"   (Codex)
  clientVersion === "acp-bridge"          (Gemini)
  clientVersion === "opencode-plugin-bridge" (OpenCode)

Priority 0–N (by position):
  "claude-code", "claude", "opencode", "gemini-cli", "gemini", "codex-cli", "codex"
```

Bridge daemons always win over inner MCP clients in the same project. This is intentional: bridge daemons can inject turns directly; inner MCP clients can only pull from `channel_inbox`.

## Auto-redirect for inner clients

When `reply` or `message_client_session` targets a Codex inner client (`client-codex-mcp-client-*`) or Gemini inner client (`client-gemini-mcp-client-*`), the adapter automatically redirects to the bridge daemon for the same project. You do not need to look up the bridge agentId manually.

This means: copy `replyWith.agentId` verbatim even if it looks like an inner client — the adapter handles the redirect.

## OpenCode dual registration

OpenCode registers two entries per session:

- `client-opencode-*` — MCP client (calls tools, can use `channel_inbox` and `reply`)
- `client-opencode-bridge-*` — plugin bridge (receives push injections)

When you send to the MCP client, the adapter routes to the plugin bridge if it is present and healthy. The MCP client row stays visible in `list_agents` so the LLM can still call tools.

## Conversation ID is deterministic

Every pair of agents shares a stable `conversationId`:

```
SHA1(sorted([agentIdA, agentIdB])).slice(0, 32) → formatted as UUID
```

This means:
- Both sides always land in the same thread without pre-coordination.
- The ID is stable across registry restarts.
- If two agents initiate simultaneously, both messages arrive in the same thread.

## clientType filter

When a project has multiple sessions of different types, use `clientType` to disambiguate:

```
message_client_session(
  project: "my-project",
  clientType: "codex",   // "claude-code" | "opencode" | "codex" | "gemini"
  message: "..."
)
```

`clientType` is ignored when `clientId` is set.

## WebSocket targeted delivery

When a message has `toAgentId`, the registry delivers it directly to that agent's WS connection before broadcasting to all subscribers. This means agents NOT in `toAgentId` may still see the broadcast but will not receive the targeted delivery event. The dashboard only updates on targeted delivery if its agentId matches `toAgentId` or if `toAgentId` is absent.
