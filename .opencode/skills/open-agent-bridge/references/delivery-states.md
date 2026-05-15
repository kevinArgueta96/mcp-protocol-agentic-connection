# Delivery States and ACKs

## State machine

```
queued
  └─→ delivered_to_bridge
        └─→ displayed_to_client
              ├─→ answered
              └─→ failed
```

Any state can also transition directly to `failed` if the delivery attempt exhausts retries or expires.

## What each state means

| State | Meaning | Actor |
|---|---|---|
| `queued` | Message created, not yet delivered | Registry |
| `delivered_to_bridge` | Bridge daemon received the WS event | Bridge |
| `displayed_to_client` | Client session received the injection / push | Bridge or MCP adapter |
| `answered` | A reply was sent on the same `conversationId` | Any agent |
| `failed` | Delivery failed and will not be retried | Registry or bridge |

## ACK record structure

```typescript
{
  conversationId: string;
  messageId:      string;
  state:          DeliveryState;
  actorId:        string;   // who sent this ACK
  actorType:      "registry" | "bridge" | "client" | "agent";
  timestamp:      number;
  detail?:        string;   // human-readable reason on failure
}
```

## Automatic ACKs

Each bridge sends ACKs automatically:

- `delivered_to_bridge` — sent as soon as the WS channel event is received
- `displayed_to_client` — sent after the injection succeeds (turn injected into Codex/Gemini, prompt_async called for OpenCode, notification pushed for Claude Code)

The MCP adapter sends both ACKs for Claude Code peers.

## Retry and expiry

- Messages can have an `expiresAt` timestamp. After expiry, `channel_inbox` returns them under `expiredOnly` filtering.
- Retry via `POST /channel/messages/:convId/:msgId/retry` — increments `attemptCount` and re-delivers.
- Gemini queue: up to 10 messages buffered while a turn is in progress; each retried up to 3 times with 5s delay.
- ACK sweep runs every 60s to mark expired messages as `failed`.

## Suppression

Conversations can be hidden from inbox listings without deleting them:

```
POST /channel/conversations/:id/suppress    → hides from channel_inbox
DELETE /channel/conversations/:id/suppress  → restores
```

Suppressed conversations still exist in SQLite and can be retrieved directly. The WS events `channel.conversation.suppressed` and `channel.conversation.revived` are broadcast on change.

## Persistence

All messages and ACKs are stored in SQLite at `.open-agent-bridge/registry.sqlite` in three tables:

- `channel_messages`
- `channel_acks`
- `channel_suppressed_conversations`

Conversations are cleaned up hourly; retention is 30 days. The registry can restart without losing message history.
