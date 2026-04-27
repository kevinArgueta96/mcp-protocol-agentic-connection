# Channel reliability — push notifications & inbox state

This document analyses two bugs reported in the channel layer of `agent-bridge` and the fixes applied to address them. It also contrasts our implementation with the official Claude Code channels spec ([code.claude.com/docs/en/channels-reference](https://code.claude.com/docs/en/channels-reference)) and lists improvements still on the table.

## Symptoms

1. **Push notifications occasionally stop arriving** — a channel message reaches the registry but never surfaces in the receiving Claude session, and a subsequent sync does not replay it.
2. **Already-resolved messages reappear at startup** — when the console restarts, conversations that were previously answered show up again in `channel_inbox` (and as push events) as if they were new.

Both bugs share the same architectural surface — the path from `RegistryServer` → `ChannelClientRuntime` → `McpAgentBridge.deliverChannelMessage` — but have distinct root causes.

## Spec recap (Claude Code channels)

From the official reference, the contract this server must honour:

- Capability declared in the MCP `Server` constructor: `experimental: { 'claude/channel': {} }`.
- Notification method: `notifications/claude/channel` with shape:
  ```ts
  { content: string, meta?: Record<string, unknown> }
  ```
- The host wraps the event into a `<channel source="..." [meta]>...</channel>` tag in Claude's context.
- Two-way channels expose a standard MCP `tools: {}` capability and a `reply` tool (we expose `reply` and `message_client_session`).
- The spec does **not** define delivery guarantees, dedup, or replay semantics — those are entirely the channel server's responsibility. So inbox correctness across reconnects/restarts is on us.

Our `ClaudeClientProfile.mapChannelMessage` (`src/client/profiles/claude-client-profile.ts`) produces exactly the shape required by the spec, so the wire format is not the issue.

## Bug 1 — Push notifications occasionally stop arriving

### Root cause

`McpAgentBridge.deliverChannelMessage` (`src/mcp/adapter.ts`) had two flaws:

1. **Mark-before-push race**. The message id was added to `surfacedInboxMessageIds` *before* `tryPushNotification` ran. If the push permanently failed (e.g. transient stdio backpressure during MCP `initialize`), the message was logged as failed but still considered "surfaced". The next `syncRegistryToLocalStore` therefore skipped it, so the recipient never saw it.
2. **Insufficient retries**. `tryPushNotification` retried only twice, with linear backoff (`500ms × attempt`), giving roughly 1.5 s of total resilience. That is too little when stdio is busy or when the host is mid-handshake.

### Fix

In `src/mcp/adapter.ts`:

- `deliverChannelMessage` no longer pre-marks the messageId. The `surfacedInboxMessageIds.add(...)` is moved **inside** the `if (success)` branch of the push promise. A failed push now leaves the message available for the next sync.
- `tryPushNotification` raised to **5 attempts** with capped exponential backoff (`250, 500, 1000, 2000, 4000 ms`, capped at 5 s). Total resilience is now ~7.5 s, which comfortably covers transient stdio backpressure.

```ts
private async tryPushNotification(notification, channelMessage, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { await this.server.server.notification(notification); return true; }
    catch (err) { /* log + capped exponential backoff */ }
  }
  return false;
}
```

## Bug 2 — Resolved messages reappear at startup

### Root cause

Three independent issues combined:

1. `seedFromSnapshot(messages)` (`src/client/channel-client-runtime.ts`) replayed only the **messages** of `ChannelConversationSnapshot`, never the **acknowledgements**. So after a sync the local `ConversationSessionStore` had no `lastAckState` for any conversation — every prior thread looked "open".
2. `surfacedInboxMessageIds` is an in-memory `Set` constructed in `McpAgentBridge`. It is empty on every restart.
3. `syncRegistryToLocalStore` filtered messages only by `fromAgentId !== self`, `not in surfacedInboxMessageIds`, profile acceptance, and `expiresAt`. **There was no check on whether the registry already recorded a terminal ack** (`displayed_to_client`, `answered`, `failed`).

End result on restart: every prior message that wasn't sent by us and hadn't expired was treated as a new inbound notification.

### Fix

In `src/client/channel-client-runtime.ts`:

- `seedFromSnapshot` now accepts an optional `acks` parameter and replays them in timestamp order through `conversationStore.trackAck()`. This reconstructs `lastAckState`, `awaitingReply`, and `pendingMessageIds` exactly as they were when the registry persisted them.

```ts
seedFromSnapshot(messages: ChannelMessage[], acks?: ChannelAck[]): void {
  for (const m of messages) this.conversationStore.trackMessage(m);
  if (acks) {
    const sorted = [...acks].sort((a, b) => a.timestamp - b.timestamp);
    for (const a of sorted) this.conversationStore.trackAck(a);
  }
}
```

In `src/mcp/adapter.ts → syncRegistryToLocalStore`:

- Pass `snapshot.acknowledgements` to `seedFromSnapshot` so the local store reflects ack history.
- Build a per-conversation set of messageIds that already reached a **terminal ack state** (`displayed_to_client | answered | failed`) and skip them when computing `unsurfacedMessages`. They are also added to `surfacedInboxMessageIds` for in-process dedup against any concurrent live delivery.

```ts
const TERMINAL_ACK_STATES = new Set(["displayed_to_client", "answered", "failed"]);
// ...
const handledIds = new Set<string>();
for (const ack of snapshot.acknowledgements ?? []) {
  if (TERMINAL_ACK_STATES.has(ack.state)) handledIds.add(ack.messageId);
}
for (const msg of snapshot.messages) {
  if (msg.fromAgentId === this.clientAgentId) continue;
  if (this.surfacedInboxMessageIds.has(msg.messageId)) continue;
  if (handledIds.has(msg.messageId)) {
    this.surfacedInboxMessageIds.add(msg.messageId);
    continue;
  }
  // ... profile/expiry checks
  unsurfacedMessages.push(msg);
}
```

This is the canonical fix because the **registry's SQLite ledger of acks is the source of truth** — surviving across restarts, reconnects, and even machine reboots. We no longer rely on an in-memory set as the deduplication oracle for cross-restart correctness.

## Why this also covers reconnects, not just restarts

`syncRegistryToLocalStore` is called from two places:

1. After client activation in `setupClientDetection.oninitialized`.
2. On every `ws.open` (initial connect and after every reconnect).

Both paths now reconstruct ack history from the registry, so a transient WS drop while a user typed a reply on the other side cannot cause the reply to be re-surfaced as "new" — its `answered` ack is replayed first.

## Improvements still on the table

These are not implemented yet but follow naturally:

| Improvement                                                                            | Why                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persist `surfacedInboxMessageIds` to a small sqlite/json file under `.agent-bridge/`   | Belt-and-suspenders for cases where a message was pushed (`displayed_to_client` ack posted) but the host crashed before processing. Today the next sync re-pushes — usually harmless but worth eliminating. |
| Server-side TTL on `queued` acks                                                       | If a recipient never returns a `delivered_to_bridge` ack within N minutes, registry can mark the message `failed` and surface it on the dashboard for operator action.       |
| Heartbeat-driven stale WS eviction                                                     | `agentWsMap` can hold a half-open WS that doesn't trigger `close` immediately. Pinging `_isAlive` already exists; tighten the interval and evict aggressively.               |
| Backpressure-aware notification queue                                                  | When `server.server.notification` is throwing repeatedly, queue notifications instead of dropping after retries. Drain on next successful push.                              |
| Idempotency on `POST /channel/messages`                                                | The transport already supports `messageId` on the body, but the registry could 200-OK on duplicates instead of inserting a fresh row. Avoids duplicate WS broadcasts on retry.|
| Per-conversation surfaced-id watermark                                                 | Instead of a per-message Set, track the highest `createdAt` per conversation that was surfaced. Bounded memory regardless of inbox length.                                   |

## Files modified

- `src/client/channel-client-runtime.ts` — `seedFromSnapshot` accepts and replays acks.
- `src/mcp/adapter.ts` — `deliverChannelMessage` defers `surfacedInboxMessageIds.add` until push succeeds; `tryPushNotification` uses 5 attempts with capped exponential backoff; `syncRegistryToLocalStore` skips messages with terminal acks.

## Verification

`pnpm run build` (i.e. `tsc`) passes.

Behavioural verification still pending — recommended manual test:

1. From client A, send `message_client_session` to client B with `expectsResponse=true`.
2. From client B, `reply` to it. Confirm `lastAckState=answered` in `channel_inbox`.
3. Restart client B. Open a fresh session.
4. **Before fix**: the message reappears as a pending inbox item.
5. **After fix**: `channel_inbox(pendingOnly=true)` returns "No pending channel conversations".

For the push reliability fix, simulate stdio backpressure by writing a large MCP response just before a channel message arrives; with the previous 2-retry budget the message would drop, with the new 5-retry+exponential budget it lands.

## Related docs

- [`channel-messaging-flow.md`](./channel-messaging-flow.md) — end-to-end flow and architecture
- [`a2a-and-api.md`](./a2a-and-api.md) — A2A protocol surface
- [Claude Code channels reference (external)](https://code.claude.com/docs/en/channels-reference)
