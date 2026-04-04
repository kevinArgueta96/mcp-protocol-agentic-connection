# Channel Client Runtime Plan

## Goal

Create a shared client runtime so Codex, Claude, dashboard, Gemini, and future clients behave the same way over agent-bridge channels.

The runtime must standardize:

- client registration in the registry
- websocket identification
- heartbeat and reconnect
- channel message send and receive
- acknowledgements
- conversation correlation
- replies
- timeouts and delivery state

This plan focuses only on the client messaging layer.

## Why This Exists

Right now the messaging behavior is split across different places:

- `src/mcp/adapter.ts`
- `dashboard/src/stores/registry.ts`
- `dashboard/src/stores/chat.ts`

That causes drift between clients:

- some clients are real channel participants
- others only post messages
- reply behavior is not uniform
- reconnect and heartbeat logic is duplicated

The fix is to create one shared runtime and make each client use it.

## Scope

In scope:

- shared runtime for channel clients
- shared transport against registry HTTP + WS
- shared conversation behavior
- dashboard migration
- MCP / client bridge migration
- Codex-first client support

Out of scope:

- agent skill execution changes
- LangGraph
- semantic memory
- dashboard design changes unrelated to messaging

## Target Architecture

The runtime should evolve with a DDD-like split so we can keep one shared messaging model while still using client-specific behavior when needed.

### Domain Layer

Responsibility:

- channel message model
- channel ack model
- conversation state model
- delivery policy rules
- reply correlation rules

Proposed files:

- `src/domain/channel/channel-message.ts`
- `src/domain/channel/channel-ack.ts`
- `src/domain/channel/conversation.ts`

### Application Layer

Responsibility:

- orchestrate client lifecycle
- use transport + domain rules
- select the correct client behavior profile
- expose runtime APIs to adapters

Proposed files:

- `src/client/channel-client-runtime.ts`
- `src/client/conversation-session-store.ts`
- `src/client/client-profile-resolver.ts`
- `src/client/conversation-service.ts`

### Infrastructure Layer

Responsibility:

- registry HTTP transport
- registry websocket transport
- MCP / client notification bridge
- dashboard bindings
- future Codex bindings

Proposed files:

- `src/client/channel-transport.ts`
- `src/mcp/adapter.ts`
- `dashboard/src/stores/*`

### 1. Registry Transport

Responsibility:

- register client
- deregister client
- heartbeat
- connect websocket
- identify client on websocket
- send channel message
- send channel ack

Proposed file:

- `src/client/channel-transport.ts`

### 2. Channel Client Runtime

Responsibility:

- hold client identity
- manage connection lifecycle
- expose send / reply APIs
- receive directed messages
- maintain recent message correlation
- emit typed runtime events

Proposed file:

- `src/client/channel-client-runtime.ts`

### 3. Conversation Session Store

Responsibility:

- active conversation tracking
- reply correlation
- message state transitions
- local session history
- pending response state
- reply context resolution for adapters

Proposed file:

- `src/client/conversation-session-store.ts`

### 4. Client Adapters

Responsibility:

- translate runtime events into local UI or local protocol behavior

Adapters:

- dashboard adapter
- MCP / client adapter
- Codex adapter
- Claude adapter
- Gemini adapter

### 5. Client Behavior Profiles

Responsibility:

- choose client-specific behavior without breaking the shared runtime
- preserve known-good Claude behavior
- make Codex the default production-facing client layer
- allow Codex, Claude, and dashboard to evolve independently

Examples:

- `ClaudeClientProfile`
- `DashboardClientProfile`
- `CodexClientProfile`

The runtime should not hardcode Claude semantics directly.
Instead, it should resolve a profile and delegate behavior such as:

- how inbound channel messages are surfaced
- when `displayed_to_client` is emitted
- how reply shortcuts are inferred
- whether legacy compatibility paths are needed
- how interruptions or incomplete replies are handled

## Recommended DDD Direction

Use this split:

- **Domain**
  channel entities, delivery states, invariants
- **Application**
  runtime orchestration, profile resolution, conversation coordination
- **Infrastructure**
  registry transport, MCP server bindings, dashboard UI bindings

This gives us one domain model, but lets us say:

- if client type is Claude, use the known-good Claude-specific adapter/profile
- if client type is dashboard, use the dashboard adapter/profile
- if client type is Codex, use the Codex adapter/profile

The decision logic should be explicit and centralized, not scattered.

## Client Profile Resolution

Add a resolver that decides which implementation profile to use.

Example shape:

```ts
interface ClientBehaviorProfile {
  id: string;
  supportsLegacyNotify: boolean;
  shouldAcceptMessage(message: ChannelMessage, selfId: string): boolean;
  onMessageDisplayed?(message: ChannelMessage): Promise<void>;
  mapInboundToLocalEvent(message: ChannelMessage): unknown;
}
```

## Current Progress

- Phase 1: completed
  shared registry transport extracted to `src/client/channel-transport.ts`
- Phase 2: in progress
  shared runtime active in `src/client/channel-client-runtime.ts`
- Phase 2A: completed
  client-specific behavior moved behind profiles (`ClaudeClientProfile`, `CodexClientProfile`, `GeminiClientProfile`)
- Phase 3: in progress
  conversation state extracted to `src/client/conversation-session-store.ts`
  and `reply` context is now being centralized in the runtime/store layer
- Phase 4: in progress
  dashboard has started migrating to runtime + profile seams

## Latest Summary

- Node-side no longer needs to keep reply inference in the MCP adapter only.
- The runtime/store layer now owns conversation correlation and reply context resolution.
- The MCP surface is moving from Claude-specific naming to generic client-session naming.
- Codex is now the target production client layer; Claude remains compatibility-first, Gemini follows the same seam.
- Codex and Gemini are now modeled as inbox-first clients; Claude remains push-first via native Claude channels.
- Inbox-first clients now receive a lightweight reminder notification and rely on `channel_inbox` for the full message body and reply flow.
- Inbox-first clients also receive repeated reminder notifications while a pending message remains unanswered.
- Inbox-first clients now run a lightweight local inbox poll with message watermarks so newly pending messages are surfaced automatically.
- Inbox-first automation is now configurable from `.agent-bridge.mcp.yml`, with global `nonNative` defaults and per-client overrides such as `codex` and `gemini`.
- Codex now has a dedicated proxy layer in the MCP bridge so inbound and pending messages are surfaced with conversation context instead of generic reminders only.
- The dashboard now includes a manual `remind` action on active client-session threads so an operator can keep a Codex or Gemini conversation moving without leaving the chat UI.
- This reduces Claude-specific orchestration in `src/mcp/adapter.ts` and moves the project closer to a real application-layer runtime.
- The runtime now also owns conversation update events, message listing per conversation,
  and delivery acknowledgements as application APIs instead of adapter-level transport calls.
- A minimal `ConversationService` now sits above the runtime for MVP use cases:
  start conversation, reply-and-acknowledge, inspect pending snapshots.
- The MCP adapter now consumes that service for `message_claude_client`, `reply`,
  and a new `channel_inbox` debugging view of pending conversations.
- Conversation snapshots now expose derived status and recent-conversation listing,
  so the MVP can inspect local conversational state without reaching into registry persistence.
- Local expiration semantics are now derived at the conversation-service layer from `expiresAt`,
  so the MVP can distinguish `pending` from `expired` without inventing new registry-side state yet.
- The MVP now has explicit local operations to:
  - mark expired conversations as `failed`
  - delete conversations from the local runtime store
- These actions are exposed through MCP tools instead of being hidden side effects in inbox inspection.
- Local deletions now behave like tombstones in the runtime store:
  incoming channel events for a deleted conversation are ignored until that conversation
  is explicitly reopened by a local send operation.
- Registry conversation summaries are now aligned with the client model:
  pending and expired state is computed across all pending messages in the conversation,
  not only from `lastMessage`.
- Conversation suppression now lives in the registry as the single source of truth.
  Local runtime tombstones are synchronized from registry suppression / revival events.

## Next Step

- keep node-side and registry semantics aligned
- decide whether suppression should evolve into archive semantics with actor metadata and timestamps
- if Codex needs more autonomy than inbox-first + reminders, evolve the proxy layer instead of adding more YAML-only behavior

Resolution examples:

- `clientInfo.clientName === "claude-code"` -> `ClaudeClientProfile`
- `clientInfo.clientName === "dashboard"` -> `DashboardClientProfile`
- `clientInfo.clientName === "codex"` -> `CodexClientProfile`

## Why This Is Better

This avoids two bad outcomes:

1. making every client behave exactly like Claude even when they should not
2. duplicating runtime logic in every adapter again

Instead:

- shared runtime stays common
- Claude keeps the behavior we already know works
- other clients plug into the same lifecycle with their own presentation rules

## Standard Behavior For Every Client

Every client must:

1. register as `entryType=client`
2. open websocket to registry
3. identify with `agentId`
4. send heartbeat periodically
5. only process messages directed to itself
6. emit delivery ACKs consistently
7. use the same reply correlation rules
8. disconnect cleanly when possible

## Shared Client Identity Model

Each client runtime should expose:

```ts
interface ChannelClientIdentity {
  agentId: string;
  name: string;
  projectName: string;
  projectPath: string;
  clientName: string;
  clientVersion: string;
}
```

## Shared Runtime API

First draft:

```ts
interface ChannelClientRuntime {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(input: SendChannelMessageInput): Promise<ChannelMessage>;
  reply(input: ReplyChannelMessageInput): Promise<ChannelMessage>;
  onMessage(listener: (message: ChannelMessage) => void): () => void;
  onAck(listener: (ack: ChannelAck) => void): () => void;
  onState(listener: (state: ChannelRuntimeState) => void): () => void;
}
```

## Shared Delivery Policy

Rules:

- outgoing messages start as `queued`
- when runtime accepts inbound directed message, send `delivered_to_bridge`
- when local client renders or surfaces the message, send `displayed_to_client`
- when local client sends reply, send `answered`
- failures send `failed`

## Implementation Phases

### Phase 1: Extract Transport

Status: `completed`

Tasks:

- move registry HTTP helpers into shared transport
- move WS identify logic into shared transport
- centralize client register / deregister / heartbeat

Target outcome:

- dashboard and MCP no longer own raw registry client lifecycle separately
- shared transport now exists in `src/client/channel-transport.ts`
- MCP adapter now uses the shared transport for client register, deregister, heartbeat, channel message, channel ack, and websocket identify

### Phase 2: Create Shared Runtime

Status: `in_progress`

Tasks:

- create `ChannelClientRuntime`
- add local event emitter
- support send + reply
- support receive + ack
- support reconnect lifecycle
- add client behavior profile hook points

Target outcome:

- one reusable runtime usable by any client
- runtime created in `src/client/channel-client-runtime.ts`
- MCP adapter now consumes runtime events for WS open/close, registry events, channel messages, legacy notify, and agent.message relay
- recent channel message correlation moved behind the runtime API
- next sub-step is profile-based behavior routing instead of hardcoded Claude rules in the MCP adapter

### Phase 2A: Client Profiles

Status: `completed`

Tasks:

- define client behavior profile contract
- define client profile resolver
- add `ClaudeClientProfile`
- route Claude-specific channel behavior through the profile

Target outcome:

- Claude-specific behavior remains known-good
- client-specific behavior is explicit and swappable
- MCP adapter stops owning Claude behavior rules directly
- `DefaultClientProfileResolver` created
- `ClaudeClientProfile` created
- MCP adapter now delegates channel acceptance and notification mapping to the Claude profile

### Phase 3: Extract Conversation Store

Status: `in_progress`

Tasks:

- track active conversations
- store recent messages for reply inference
- manage pending response state
- normalize local message history model

Target outcome:

- dashboard and MCP stop reimplementing correlation logic
- `src/client/conversation-session-store.ts` created
- `src/client/channel-client-runtime.ts` now delegates recent message tracking and conversation state to the session store
- runtime can query recent messages and pending conversations without owning raw maps

### Phase 4: Migrate Dashboard

Status: `in_progress`

Tasks:

- replace direct channel chat logic with runtime
- replace dashboard registration lifecycle with runtime
- use runtime events to update chat UI

Target outcome:

- dashboard becomes a first-class channel client built on shared runtime
- dashboard now uses a single shared web runtime in `dashboard/src/lib/channel-runtime.ts`
- registry store and chat store no longer own separate WebSocket / registration lifecycles
- dashboard-specific acceptance logic extracted into `dashboard/src/lib/client-profiles.ts`
- dashboard chat session logic extracted from the store into a dedicated session component
- store layer is now mostly an adapter over runtime/session behavior
- dashboard now also has a profile resolver seam, matching the backend runtime/profile direction

### Phase 5: Migrate MCP / Claude Bridge

Status: `pending`

Tasks:

- replace duplicated client registration logic in `src/mcp/adapter.ts`
- replace local message correlation map with runtime-backed behavior
- keep Claude-specific notification rendering in the Claude behavior profile / adapter path

Target outcome:

- MCP bridge becomes an adapter using the shared runtime plus Claude profile

### Phase 6: Prepare Codex Adapter

Status: `pending`

Tasks:

- define thin Codex-facing adapter behavior
- ensure no Claude-only assumptions remain in runtime
- document how Codex should consume the runtime

Target outcome:

- Codex can be added with minimal new messaging code

## Proposed File Changes

New files:

- `src/client/channel-transport.ts`
- `src/client/channel-client-runtime.ts`
- `src/client/conversation-session-store.ts`
- `src/client/client-profile-resolver.ts`
- `src/client/profiles/claude-client-profile.ts`
- `src/client/profiles/dashboard-client-profile.ts`
- `src/client/profiles/codex-client-profile.ts`

Expected updates:

- `src/mcp/adapter.ts`
- `dashboard/src/stores/registry.ts`
- `dashboard/src/stores/chat.ts`
- `dashboard/src/lib/registry-client.ts`
- `dashboard/src/types/index.ts`

## Migration Rules

- do not break the registry protocol
- do not remove current channel endpoints
- keep current message schema stable
- migrate dashboard first or MCP first only after shared runtime exists
- adapters may stay thin but must not own transport lifecycle logic

## Risks

### Risk 1

Breaking current Claude channel flow while extracting runtime.

Mitigation:

- preserve existing registry protocol
- migrate in small steps
- keep MCP adapter behavior stable until runtime is validated

### Risk 2

Mixing transport concerns with UI concerns again.

Mitigation:

- keep runtime free of Vue / MCP UI details
- adapters should only translate events, not reimplement messaging

### Risk 3

Codex support inheriting Claude assumptions.

Mitigation:

- keep runtime channel-generic
- isolate Claude-specific notification behavior in MCP adapter

## Definition Of Done

This initiative is done when:

- dashboard uses shared runtime
- MCP / Claude bridge uses shared runtime
- reply behavior is consistent across clients
- registration / heartbeat / identify are no longer duplicated
- a Codex adapter can be added without redesigning the messaging core

## Progress

- Phase 1: completed
- Phase 2: in_progress
- Phase 2A: completed
- Phase 3: in_progress
- Phase 4: in_progress
- Phase 5: pending
- Phase 6: pending

## Last Summary

- shared transport extracted into `src/client/channel-transport.ts`
- `src/mcp/adapter.ts` migrated off direct registry fetch calls for client/channel lifecycle
- build verified with `pnpm run build`
- architecture direction updated to use a DDD-like split with client behavior profiles
- Claude should keep a dedicated known-good profile instead of being flattened into a generic client path
- shared runtime created in `src/client/channel-client-runtime.ts`
- MCP adapter now uses runtime events instead of owning all registry WS handling directly
- build verified again with `pnpm run build`
- profile contract file started in `src/client/client-profile-resolver.ts`
- active implementation focus moved to `ClaudeClientProfile` and resolver wiring
- `src/client/profiles/claude-client-profile.ts` implemented
- `src/client/client-profile-resolver.ts` now resolves the Claude profile
- `src/mcp/adapter.ts` no longer hardcodes Claude channel mapping directly
- build verified again with `pnpm run build`
- `dashboard/src/lib/channel-runtime.ts` added as the shared runtime entrypoint for the web client
- `dashboard/src/stores/registry.ts` and `dashboard/src/stores/chat.ts` now consume that runtime instead of duplicating transport lifecycle logic
- dashboard build verified with `cd dashboard && pnpm run build`
- `dashboard/src/lib/channel-chat-session.ts` added to own conversation/session logic
- `dashboard/src/lib/dashboard-client-profile.ts` now owns dashboard-side message acceptance and mapping rules
- `dashboard/src/stores/chat.ts` reduced to a thin adapter around the session
- `dashboard/src/lib/dashboard-client-profile-resolver.ts` added so the web client follows the same runtime/profile/resolver pattern as the backend
- `src/client/conversation-session-store.ts` added for Node-side conversational state
- `src/client/channel-client-runtime.ts` now uses the conversation store instead of a raw recent-message map
- backend build verified again with `pnpm run build`

## Next Step

Implement Phase 2:

- stabilize the runtime/profile seam
- continue Phase 4 dashboard migration toward the shared runtime/profile approach
- move more conversation/session behavior out of dashboard stores and into the web runtime
- finish aligning dashboard runtime/profile shape with the Node runtime/profile split
- next decision point is whether `/channels` should move onto the shared web runtime or remain a REST-backed observability view for the MVP
- continue Phase 3 by deciding whether the web side also gets a generalized conversation store or stays with a dashboard-specific session object for the MVP
