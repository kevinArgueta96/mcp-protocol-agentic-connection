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

## Bug 5 — Duplicate broadcasts on `POST /channel/messages` retries

### Symptom

If a client retries `POST /channel/messages` (transient network error, or any future client-side retry policy) with the same explicit `messageId`, the registry would broadcast the message again. Receivers had to dedup at their layer (which they now do, after Bugs 1–3), but the registry itself was re-broadcasting.

### Fix

`ChannelStore.createMessage` is now idempotent on `messageId`:

- Returns `{ message, created }`.
- If `messageId` already exists in `channel_messages`, returns the persisted row with `created=false`. Switched the `INSERT OR REPLACE` to plain `INSERT` since duplicates short-circuit before reaching it.
- Both `POST /channel/messages` handlers in `src/registry/server.ts` (the modern channel endpoint and the legacy `claude.notify` shim) suppress the global broadcast, the targeted WS send, and the legacy `claude.notify` event when `!created`. The HTTP response still echoes the canonical persisted message so the retry can be treated as success; a `deduplicated: true` flag is added to the body for observability.

The result: senders can retry safely on any transient failure without polluting receivers' inboxes.

## Bug 6 — `replyWith.agentId` exposed inner Codex/Gemini IDs

### Symptom

`channel_inbox` returned `replyWith.agentId = latestInbound.fromAgentId`. For Codex/Gemini peers, that was the inner MCP-client identity (e.g. `client-codex-mcp-client-*`). Callers that copied the value verbatim into `reply` triggered the auto-redirect (Bug 4 fix), but the surfaced UX still leaked the wrong-looking id.

### Fix

The `channel_inbox` handler now prefetches the agents list once, builds a `(projectPath → bridge)` index, and resolves `replyWith.agentId` to the bridge agentId for any Codex/Gemini inner client. The original raw value is preserved in a new `replyWith.originalFromAgentId` field for traceability when a redirect happened. Claude Code peers and bridges pass through unchanged (no `originalFromAgentId` field present).

Net effect: an LLM that copies `replyWith.agentId` directly now sees the bridge id from the start, the auto-redirect in `reply` is a no-op for that case, and the UX matches the actual delivery target.

## Bug 7 — Unbounded in-process dedup sets

### Symptom

`McpAgentBridge.surfacedInboxMessageIds` and the bridges' `injectedMessageIds` were plain `Set<string>` instances. Their size grows linearly with traffic for the lifetime of a process — a daemon running for weeks would slowly leak memory proportional to message volume.

### Fix

Introduced `BoundedIdSet` (`src/client/bounded-id-set.ts`): an insertion-ordered set with a hard cap (default 5 000 entries) that evicts the oldest id on overflow. Applied in:

- `src/mcp/adapter.ts` — `surfacedInboxMessageIds`
- `src/client/codex-app-server-bridge.ts` — `injectedMessageIds`
- `src/client/gemini-acp-bridge.ts` — `injectedMessageIds`

The eviction can never cause duplicate delivery: the registry's persisted ack ledger is the authoritative source for "did I already handle this?", and the sync-on-startup / sync-on-reconnect paths rebuild the in-process set from there. A bounded set just means the same already-handled message might fail the in-memory dedup check once after eviction — at which point the registry's terminal-ack filter (Bugs 2 and 3) kicks in and skips it correctly.

## Bug 8 — Pending conversations stuck in `pending` forever

### Symptom

A message with `expectsResponse=true` whose `expiresAt` deadline passed without a reply stayed visible to the dashboard / inbox as `pending` (or, if the read-time computation flagged it, `expired`). The registry never *wrote* a terminal ack, so subscribers waiting on the conversation state machine had no event to react to.

### Fix

`ChannelStore.findExpiredAwaitingReply(now)` returns every message with `expectsResponse=true`, `expiresAt <= now`, and no terminal (`answered` / `failed`) ack. The registry server runs an **ack sweeper** every 60 s (`ACK_SWEEP_INTERVAL_MS`) that:

1. Finds expired-awaiting-reply messages.
2. For each, persists a `failed` ack with `actorId="registry"`, `actorType="registry"`, and detail `"Expired without reply (registry sweeper)"`.
3. Broadcasts a `channel.ack` event so live subscribers see the state transition.

Senders polling `waitForAcknowledgement` now unblock with `failed` instead of timing out silently, and dashboards get a definitive end-state. The sweeper is started in `RegistryServer.start()` and cleared in `stop()`.

## Tests

Three test suites cover the critical paths:

- `src/__tests__/channel-store-idempotency.test.ts` — `createMessage` returns `created=true` on first insert and `created=false` on duplicate `messageId` without overwriting; `findExpiredAwaitingReply` correctly filters by `expiresAt`, `expectsResponse`, and the latest ack state.
- `src/__tests__/seed-from-snapshot.test.ts` — `seedFromSnapshot(messages, acks)` reconstructs `lastAckState` and `awaitingReply`; acks are applied in timestamp order so the latest one wins.
- `src/__tests__/bounded-id-set.test.ts` — capacity, FIFO eviction, no-op duplicate add, clear semantics.

`pnpm test` is green: 58 tests across 5 suites (the existing `channel-dedup` and `registry-store` plus the three new ones).

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

## Bug 3 — Same class of bugs in the Codex / Gemini bridges

### Context

`McpAgentBridge` is the channel client when the host is **Claude Code** (an MCP server speaking `notifications/claude/channel`). For **Codex** and **Gemini** the channel client is a separate daemon that:

- spawns the underlying agent process (`codex app-server` / `gemini --acp`),
- keeps a single long-lived ACP/JSON-RPC session,
- on each inbound `channel.message`, **injects** the content as a new turn prompt into the agent.

These two daemons live in `src/client/codex-app-server-bridge.ts` and `src/client/gemini-acp-bridge.ts`. They both subscribe to the same WS event stream from the registry and use the same `ChannelTransport` / `ChannelClientRuntime` machinery — so they inherit the registry-level reliability we already fixed for Claude.

But they had two **bridge-specific** gaps:

1. **No startup sync.** The bridges only listened to live `channel.message` events. Any message that landed at the registry while the bridge was offline (machine reboot, daemon restart, transient crash) was never injected into the underlying agent. From the user's perspective, "messages stopped arriving" — even though the registry had them persisted.
2. **No dedup of injected messages.** Since the registry can broadcast the same `channel.message` more than once (sender retries, conversation revives, snapshot replays overlapping with live events), the bridge could re-inject the same prompt — the agent would see duplicate turns.

### Fix

In both `codex-app-server-bridge.ts` and `gemini-acp-bridge.ts`:

- **`injectedMessageIds: Set<string>`** — populated from (a) every successful in-process injection and (b) terminal acks owned by this bridge actor on startup/reconnect.
- **`syncMissedMessages()`** — a new method called after `activateClient(...)` and on every `ws.open`. It pulls all conversations from the registry HTTP API, walks `acknowledgements`, and:
  - Marks any message the registry already saw this bridge ack as `delivered_to_bridge | answered | failed` as `injectedMessageIds`.
  - Replays through `enqueueOrInject` every message that targets us (or is broadcast) and is not yet handled, not from us, and not expired.
- **Live `channel.message` dedup** — the handler now short-circuits when `injectedMessageIds.has(messageId)`.
- **Mark-on-success** — `injectedMessageIds.add(...)` is called *before* posting the `delivered_to_bridge` ack so a same-tick re-broadcast can't slip through.

The contract becomes: the **registry's persisted ack ledger** is the single source of truth for "did this bridge already inject this message?" — surviving restarts and reconnects.

### Why this matches the protocol surfaces

- **Codex app-server**: Codex's app-server (`codex app-server --listen ws://...`) accepts injection requests via the bridge's `CodexAppServerClient`, which speaks JSON-RPC over WS to the spawned `codex` process. The protocol exposes `turn/start` (etc.) but offers no replay or "what did I miss" semantics — recovery has to live above it. That's exactly what `syncMissedMessages()` provides.
- **Gemini ACP**: per the [ACP spec](https://agentclientprotocol.com/protocol/prompt-turn) (`session/prompt` + `session/update` notifications + `session/cancel`), each prompt is one full turn cycle ending in a `StopReason`. There is no protocol-level "list missed prompts since last seen" — replay is again the bridge's responsibility. Our `syncMissedMessages()` aligns with this: it does its own replay against the registry, then feeds prompts one-by-one through `client.sendPrompt(...)` so each runs as a normal ACP turn.

The bridges already declared the right capabilities in their respective `initialize` handshakes (Codex app-server's `tui_app_server` for turn injection; Gemini ACP's `session/new` with `cwd` + `mcpServers`), so the only gap was the higher-level recovery layer — now closed.

## Bug 4 — Codex/Gemini "stuck at `delivered_to_bridge`" routing trap

### Symptom (from a real session)

A Claude Code session sent a message to a Codex peer and got a reply. The reply arrived as a `<channel>` push with `from_agent=client-codex-mcp-client-*`. Claude then sent a follow-up using *that* `fromAgentId` as the recipient. The follow-up landed at state `delivered_to_bridge` and **never advanced** to `displayed_to_client` or `answered`. The Codex agent never saw the message.

### Root cause

A Codex (or Gemini) session that loads `agent-bridge` as an MCP plugin registers **two** entries in the registry for the same project:

- **Bridge daemon** — `client-codex-bridge-*` / `client-gemini-bridge-*`. Injects messages as new turn prompts via the underlying ACP/app-server protocol. **Can deliver to the agent.**
- **Inner MCP client** — `client-codex-mcp-client-*` / `client-gemini-mcp-client-*`. Runs *inside* the agent and receives `notifications/message` push events, which Codex/Gemini do not act on reactively. **Cannot deliver to the agent.**

When the inner agent uses its `reply` tool, the resulting `fromAgentId` is the **inner MCP client** identity. That's the natural ID for any sender to copy back as the next recipient — but it's the wrong destination for delivery, because only the bridge can inject a turn.

The result is the documented failure mode: message reaches the registry, registry broadcasts it, the inner client gets a push it doesn't act on, the bridge ignores it (`toAgentId !== bridge.clientAgentId`), and the message stalls forever at `delivered_to_bridge`.

### Fix

Two changes in `src/mcp/adapter.ts`:

1. **`resolveDeliverableTarget(target)` helper.** Given any registry entry, if its `clientName` looks like Codex or Gemini and its `clientVersion` is **not** a bridge variant (`app-server-bridge` / `acp-bridge`), look up the matching bridge entry for the same `projectPath` and return that instead. Returns the original entry untouched for Claude Code peers and for entries that are already a bridge.
2. **Apply transparently** in both write paths:
   - `handleMessageClientSession` — after `resolveClientSession(...)`, redirect through `resolveDeliverableTarget`. The recipient seen on the wire is the bridge, even if the user passed an inner-client agentId.
   - `reply` handler — same redirect on the `agentId` argument before handing it to `ConversationService.replyAndAcknowledge`. So copying `replyWith.agentId` verbatim from `channel_inbox` always works, even when that ID is the inner MCP client of a Codex/Gemini session.

The redirect is logged once per call (`[MCP] Auto-redirect <inner> → <bridge>`) so it's observable but doesn't surface to the LLM.

### Tool description rewrite

The MCP tool descriptions and the top-level `instructions` of the `McpServer` constructor were rewritten so any LLM client (Claude, Codex, Gemini, future others) can understand the rules without external documentation:

- **Server-level `instructions`** now state explicitly: bridges vs inner clients, what each can do, that the adapter auto-redirects, and the typical failure signal (`delivered_to_bridge` not advancing).
- **`message_client_session` description** documents the delivery semantics per target type and notes that any inner-client agentId is auto-redirected, so callers can copy `from_agent` / `replyWith.agentId` directly.
- **`reply` description** explicitly tells the caller to copy `replyWith.agentId` verbatim and not try to substitute a bridge ID by hand — the adapter handles it.

This is the change that prevents the bug from re-appearing whenever a new agent (or a new LLM revision) starts using the CLI.

## Files modified

- `src/client/channel-client-runtime.ts` — `seedFromSnapshot` accepts and replays acks.
- `src/mcp/adapter.ts` — `deliverChannelMessage` defers `surfacedInboxMessageIds.add` until push succeeds; `tryPushNotification` uses 5 attempts with capped exponential backoff; `syncRegistryToLocalStore` skips messages with terminal acks; **adds `resolveDeliverableTarget` for inner→bridge auto-redirect, applied in `message_client_session` and `reply`; rewrites server `instructions` and tool descriptions to document routing rules.**
- `src/client/codex-app-server-bridge.ts` — adds `injectedMessageIds` dedup, `syncMissedMessages()` on startup and on every `ws.open`, and dedups live `channel.message` events.
- `src/client/gemini-acp-bridge.ts` — same fixes as the Codex bridge (also already had a `ws.open` re-identify hook from a prior commit; sync is now hooked to it).

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
