# Send and Reply Patterns

## Basic send

```
list_agents(includeClients: true)

message_client_session(
  clientId: "client-codex-bridge-abc123",
  message: "Review src/api/routes.ts for N+1 queries",
  expectsResponse: true
)
→ { conversationId: "conv-xyz", messageId: "msg-001", deliveryState: "queued" }
```

## Continuing a thread

Pass `conversationId` to append to an existing conversation instead of opening a new one:

```
message_client_session(
  clientId: "client-codex-bridge-abc123",
  conversationId: "conv-xyz",
  replyTo: "msg-002",
  message: "Follow-up: also check the auth middleware"
)
```

## Replying to an inbound message

After receiving a `<channel>` push or finding a pending entry in `channel_inbox`:

```
channel_inbox(pendingOnly: true)
→ entry.replyWith = {
    agentId:        "client-codex-bridge-abc123",
    conversationId: "conv-xyz",
    replyTo:        "msg-002"
  }

reply(
  agentId:        "client-codex-bridge-abc123",  // from replyWith — do not change
  conversationId: "conv-xyz",                     // from replyWith — do not change
  replyTo:        "msg-002",                       // from replyWith — do not change
  message:        "Thanks, applying fix now."
)
```

## Fire-and-forget (no reply expected)

```
message_client_session(
  project: "my-app",
  message: "Build finished. All tests passed. FYI",
  expectsResponse: false
)
```

Explicit `expectsResponse: false` suppresses the "reply required" injection prompt on the receiver's end. Alternatively, including FYI / no reply / sin respuesta in the message text infers the same behavior.

## Sending to a project when multiple clients are connected

```
message_client_session(
  project: "fit-mipyme-frontend",
  clientType: "codex",            // disambiguate: "claude-code" | "opencode" | "codex" | "gemini"
  message: "Run the test suite"
)
```

## Routing shortcuts

| Goal | How |
|---|---|
| Send to Claude Code in a project | `project: "my-app", clientType: "claude-code"` |
| Send to the bridge (not inner client) | Use the `clientId` of the bridge daemon directly |
| Reply to an inbound message | Always use `reply`, never `message_client_session` |
| Broadcast to all agents | Use CLI `broadcast` command or POST to each agentId manually |

## expectsResponse semantics

- Default is `true` — agent-to-agent messages are conversations.
- Bridge daemons inject "reply required" context when `expectsResponse: true`.
- Bridge daemons inject "informational (no reply)" context when `expectsResponse: false`.
- Claude Code receives a raw `<channel>` block either way and decides based on context.
- For deterministic behavior pass the flag explicitly; text inference is a convenience.
