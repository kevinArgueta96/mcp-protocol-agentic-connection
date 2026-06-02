# open-agent-bridge

<div style="text-align: center;">
  <img alt="version" src="https://img.shields.io/badge/version-0.1.0-blue?style=for-the-badge" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=for-the-badge&logo=node.js" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey?style=for-the-badge" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178c6?style=for-the-badge&logo=typescript" />
</div>

**Let Claude Code, OpenCode, Codex, and Gemini CLI talk to each other — over MCP, locally, bidirectionally.**

`open-agent-bridge` is a local communication hub for AI agents. It provides service discovery, bidirectional messaging, and MCP tool exposure so that Claude Code, OpenCode, Codex, and Gemini CLI running in separate projects can delegate tasks, exchange context, and coordinate work without leaving the local machine.

---

<details>
<summary><strong>Table of Contents</strong></summary>

- [TL;DR — 60-second quickstart](#tldr--60-second-quickstart)
- [Why open-agent-bridge?](#why-open-agent-bridge)
- [How it works](#how-it-works)
- [Getting started](#getting-started)
  - [Requirements](#requirements)
  - [Install](#install)
  - [1. Start the registry](#1-start-the-registry)
  - [2. Start an agent](#2-start-an-agent)
  - [3. Configure MCP](#3-configure-mcp)
- [Launching each client](#launching-each-client)
  - [Claude Code](#claude-code)
  - [OpenCode](#opencode)
  - [Codex](#codex)
  - [Gemini CLI](#gemini-cli)
  - [Dashboard](#dashboard-1)
- [MCP integration](#mcp-integration)
  - [.mcp.json](#mcpjson)
  - [Available tools](#available-tools)
- [Channels](#channels)
  - [Conversation model](#conversation-model)
  - [Message payload](#message-payload)
  - [Delivery states](#delivery-states)
  - [MCP tool reference](#mcp-tool-reference)
  - [HTTP API](#http-api)
  - [WebSocket events](#websocket-events)
  - [End-to-end example](#end-to-end-example)
- [Client bridges](#client-bridges)
  - [Claude Code bridge (push)](#claude-code-bridge-push)
  - [OpenCode bridge (plugin push)](#opencode-bridge-plugin-push)
  - [Codex bridge (app-server)](#codex-bridge-app-server)
  - [Gemini bridge (ACP)](#gemini-bridge-acp)
  - [Gemini bridge (tmux fallback)](#gemini-bridge-tmux-fallback)
  - [Delivery mode comparison](#delivery-mode-comparison)
- [Dashboard](#dashboard)
- [Skills](#skills)
  - [Built-in skills](#built-in-skills)
  - [Auto-detected skills](#auto-detected-skills)
- [CLI reference](#cli-reference)
- [Scripts](#scripts)
- [Architecture](#architecture)
- [Feature status](#feature-status)
- [Testing](#testing)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

</details>

---

## TL;DR — 60-second quickstart

```bash
# 1. Install
pnpm install

# 2. Start the registry
pnpm run dev -- registry start

# 3. In a second terminal — start an agent for your project
pnpm run dev -- start .

# 4. Generate .mcp.json for Claude Code
pnpm run dev -- mcp config --write

# 5. Launch Claude Code with the open-agent-bridge channel enabled
claude --dangerously-load-development-channels server:open-agent-bridge

# 6. Claude Code now has 5 MCP tools
```

Claude Code now has five MCP tools: `agent_bridge_guide`, `list_agents`, `channel_inbox`, `message_client_session`, `reply`.

For OpenCode, add the same MCP server command to OpenCode's MCP config and install the push plugin:

```bash
pnpm run dev -- opencode install-plugin --project .
```

---

## Why open-agent-bridge?

- **Local-first, zero infrastructure.** Everything runs on `localhost`. No cloud relay, no auth tokens, no subscriptions. The registry binds to `:4999`; agents bind to `:5001+`.
- **Native MCP integration.** Exposes the agent network as first-class MCP tools via `stdio` transport, so Claude Code, OpenCode, Codex, Gemini, and other MCP clients can use the same bridge tools.
- **Bidirectional channel, not fire-and-forget.** Messages carry a `conversationId`, delivery ACKs are tracked in SQLite, and the `reply` tool closes the loop back to the sender. Claude Code can ask Codex a question and receive the answer in the same conversation thread.
- **OpenCode plugin bridge.** The `opencode install-plugin` command installs a local OpenCode plugin that registers an OpenCode bridge client, opens a registry WebSocket, and injects incoming channel messages into the active OpenCode session with `session.prompt_async`.
- **Codex app-server bridge.** `CodexAppServerBridge` injects incoming channel messages directly into the Codex app-server via `turn/start` JSON-RPC, so Codex actually processes requests rather than just receiving raw text.
- **Gemini ACP bridge.** `GeminiAcpBridge` spawns `gemini --acp` and drives it over JSON-RPC 2.0 (stdin/stdout). Incoming channel messages are delivered as `session/prompt` calls; Gemini's replies come back programmatically — no tmux scraping needed.

---

## How it works

```
Claude Code / OpenCode / Codex / Gemini CLI / Dashboard
              |
              v
    ┌─────────────────────────────────────┐
    │       RegistryServer :4999          │
    │  HTTP  /agents /health /channel/*   │
    │  WS    /ws  (relay + broadcast)     │
    │  SQLite .open-agent-bridge/registry.sqlite│
    └──────┬─────────────┬───────────────┘
           │             │
           v             v
  ┌────────────────┐  ┌──────────────────────────┐
  │  AgentServer   │  │  McpAgentBridge (stdio)   │
  │  :5001+        │  │  list_agents              │
  │  A2A JSON-RPC  │  │  channel_inbox            │
  │  Skills        │  │  message_client_session   │
  │  AG-UI SSE     │  │  reply                    │
  └────────────────┘  └──────────────────────────┘

  ┌──────────────────────────────────────────────┐
  │  CodexAppServerBridge  (separate daemon)      │
  │  Spawns: codex app-server (:4500)             │
  │  Connects: WS to registry + WS to app-server  │
  │  Injects channel messages via turn/start       │
  └──────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────┐
  │  OpenCode plugin bridge                       │
  │  Auto-loads from .opencode/plugins/           │
  │  Connects: WS to registry                     │
  │  Injects via session.prompt_async             │
  └──────────────────────────────────────────────┘
```

Runtime components — `AgentServer`, `McpAgentBridge`, `CodexAppServerBridge`, `GeminiAcpBridge`, and the OpenCode plugin bridge — connect independently to the registry. None depends on the others being present.

**Message flow — Claude Code delegates a task to Codex:**

```plaintext
# sequence
Claude Code
  calls message_client_session MCP tool
  McpAgentBridge posts ChannelMessage to RegistryServer /channel/messages
  RegistryServer broadcasts via WS to all subscribers
  CodexAppServerBridge receives channel.message event
  CodexAppServerBridge calls turn/start on codex app-server
  Codex processes the turn and produces a reply
  CodexAppServerBridge sends reply ChannelMessage back to registry
  McpAgentBridge receives channel.message with the reply
  McpAgentBridge surfaces reply in channel_inbox
  Claude Code calls reply tool to close the conversation thread
```

---

## Getting started

### Requirements

- Node.js `>=22`
- pnpm >= 9
- (Optional) OpenCode for OpenCode bridge features
- (Optional) `codex` CLI in `$PATH` for Codex bridge features
- (Optional) `gemini` CLI in `$PATH` for Gemini bridge features

### Install

```bash
git clone <repo-url>
cd open-agent-bridge
pnpm install
```

### 1. Start the registry

The registry is the hub all agents connect to. Start it once per machine session:

```bash
pnpm run dev -- registry start
# Registry running on http://localhost:4999
```

In auto mode (`mcp start` default), the registry starts embedded — no manual step needed.

The registry exposes:

| Endpoint | Description |
| :--- | :--- |
| `http://localhost:4999` | HTTP REST (`/agents`, `/health`, `/channel/*`) |
| `ws://localhost:4999/ws` | WebSocket relay and channel broadcast |
| `http://localhost:4999/dashboard` | Dashboard SPA (requires `pnpm run build:all`) |

### 2. Start an agent

Start an agent server for a project directory:

```bash
pnpm run dev -- start /path/to/my-project
# Agent started
#   ID:      a1b2c3d4-...
#   HTTP:    http://localhost:5001
#   WS:      ws://localhost:5001/ws
#   Project: my-project
#   Skills:  file-search, endpoint-find, code-query, ...
```

> **Note:** Add `--claude` to enable the Claude Code AI backend for richer skill execution (required for `code-review` and `claude-execute` auto-detected skills).

### 3. Configure MCP

Generate the `.mcp.json` entry and write it to the current directory:

```bash
pnpm run dev -- mcp config --write
# .mcp.json written
# Restart Claude Code to pick up the new server
```

---

## Launching each client

Once the registry is running and `.mcp.json` is in place, each AI client connects to open-agent-bridge through its own startup command.

### Claude Code

```bash
claude --dangerously-load-development-channels server:open-agent-bridge
```

The `--dangerously-load-development-channels` flag tells the Claude CLI to activate the MCP server named `server:open-agent-bridge` as a development notification channel. The name `open-agent-bridge` matches the entry in `.mcp.json`. This enables:
- The five MCP tools (`agent_bridge_guide`, `list_agents`, `channel_inbox`, `message_client_session`, `reply`).
- Push notifications via `notifications/claude/channel` — incoming channel messages appear as `<channel>` blocks inline in the terminal.

The MCP adapter registers the Claude Code session automatically on the first `initialize` handshake.

### OpenCode

OpenCode needs two pieces:

1. An MCP server entry so the OpenCode model can call `list_agents`, `message_client_session`, `channel_inbox`, and `reply`.
2. The local OpenCode plugin so incoming channel messages can be pushed into the active OpenCode session automatically.

Install the plugin into a project:

```bash
open-agent-bridge opencode install-plugin --project "/absolute/path/to/your/project"
```

Or install it globally:

```bash
open-agent-bridge opencode install-plugin --global
```

The command copies `agent-bridge.ts` into `.opencode/plugins/` (or `~/.config/opencode/plugins/`) and merges the plugin dependencies into the matching `.opencode/package.json` / global package file. Local plugins are auto-loaded by OpenCode, so no `opencode.json` plugin entry is required. Restart OpenCode after installing.

The plugin registers as an OpenCode bridge client (`clientVersion: "opencode-plugin-bridge"`), opens a WebSocket to the registry, sends heartbeats, and injects matching `channel.message` events into the active session through `ctx.client.session.prompt_async`. It also re-syncs missed pending messages periodically, deduplicates message IDs, and sends `delivered_to_bridge` / `displayed_to_client` ACKs back to the registry.

When OpenCode is connected through MCP, `list_agents(includeClients=true)` shows rows like `[OpenCode]` and `[OpenCode bridge]`. Routing is automatic: sending to the OpenCode MCP client is redirected to the sibling plugin bridge when present, while the MCP client can still use `channel_inbox` and `reply`.

### Codex

```bash
open-agent-bridge codex start --project "/absolute/path/to/your/project"
```

This single command:
1. Starts the registry (if not already running).
2. Launches the `CodexAppServerBridge` daemon, which spawns `codex app-server` on `:4500`.
3. Registers the Codex client session in the registry.
4. Opens the Codex TUI.

From that point, `message_client_session` routes to the Codex bridge automatically (it has the highest delivery priority).

If you prefer to start Codex separately:

```bash
# Terminal A — bridge only
open-agent-bridge codex app-bridge --project "/absolute/path/to/your/project"

# Terminal B — Codex TUI connecting to the app-server
codex --remote ws://127.0.0.1:4500
```

A plain `codex` command starts an isolated session. The registry may still see an inner MCP client, but the bridge cannot inject automatic turns into that TUI. If no remote TUI attaches to the bridge app-server, queued messages fail with a detail that tells you to run `codex --remote ws://127.0.0.1:<port>`.

### Gemini CLI

The preferred path is the **ACP bridge** — it drives `gemini --acp` over JSON-RPC 2.0, giving the same bidirectional, programmatic delivery as the Codex app-server bridge:

```bash
open-agent-bridge gemini start --project "/absolute/path/to/your/project"
```

Or start the bridge daemon separately:

```bash
open-agent-bridge gemini app-bridge --project "/absolute/path/to/your/project"
```

This spawns `gemini --acp`, performs the ACP handshake, registers the Gemini session in the registry, and wires channel messages to `session/prompt` calls.

**Fallback — tmux pane injection** (when `--acp` mode is unavailable):

```bash
# In a tmux pane running Gemini, bind it:
open-agent-bridge gemini tmux-bind

# In a sidecar pane, poll and inject:
open-agent-bridge gemini tmux-sidecar
```

The `.gemini/settings.json` at the repo root contains a reference MCP config for Gemini CLI.

### Dashboard

```bash
# One-time: build the Vue SPA
pnpm run build:all

# Open in browser
open-agent-bridge dashboard
# → http://localhost:4999/dashboard
```

For hot-reload development: `pnpm run dev:dashboard` (Vite on `:5173`, proxies API calls to `:4999`).

---

## MCP integration

### .mcp.json

`open-agent-bridge mcp config` generates the `.mcp.json` entry. The `AGENT_BRIDGE_PROJECT` environment variable tells the MCP adapter which project to associate the Claude Code session with:

```json
{
  "mcpServers": {
    "open-agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/dist/cli/index.js", "mcp", "start"],
      "env": {
        "AGENT_BRIDGE_PROJECT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

For a globally installed version, pass `--global`:

```bash
node dist/cli/index.js mcp config --global --write
```

Which produces:

```json
{
  "mcpServers": {
    "open-agent-bridge": {
      "command": "pnpm",
      "args": ["dlx", "open-agent-bridge", "mcp", "start"],
      "env": {
        "AGENT_BRIDGE_PROJECT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

The `mcp config` command writes absolute paths for the current machine. Commit the result to the project or adapt the same `open-agent-bridge mcp start` command for your MCP client settings.

### Available tools

| Tool | Description |
| :--- | :--- |
| `agent_bridge_guide` | Built-in MCP usage guide. Returns setup, send/reply workflow, ACK semantics, and troubleshooting by topic. |
| `list_agents` | Discover connected agents and client sessions. Client rows include peer labels like `[Claude Code]`, `[OpenCode]`, `[OpenCode bridge]`, `[Codex inner]`, `[Codex bridge]`, `[Gemini inner]`, and `[Gemini bridge]`, plus the unique 8-char suffix of the agentId (e.g. `[3fdb0c6a]`) so two same-project peers stay visually distinct. Bridge routing is automatic. |
| `channel_inbox` | Inspect pending channel conversations with full context and a `replyWith` hint for responding. |
| `message_client_session` | Send a message to a named client session. Automatically resolves OpenCode/Codex/Gemini inner clients to their bridge daemon when available and infers `expectsResponse` when omitted. |
| `reply` | Respond to an incoming channel message, correlating by `conversationId`. |

Check live tool and agent status at any time:

```bash
pnpm run dev -- mcp status
```

### Agent-bridge skill (Claude Code only)

The MCP `instructions` block intentionally stays compact. The deeper guide — peer-type semantics, send/reply patterns, troubleshooting `delivered_to_bridge` stalls, OpenCode plugin setup, and Codex `--remote` setup — lives in skill files loaded on demand by each client:

- **OpenCode:** `.opencode/skills/open-agent-bridge/SKILL.md` (project-local, auto-scanned by OpenCode)
- **Codex:** `~/.codex/skills/open-agent-bridge/SKILL.md` (global Codex skill)

Each skill file includes a `references/` folder with peer-type taxonomy, send/reply patterns, delivery states, routing rules, troubleshooting ladder, and the injection prompt contract.

The same content can also be queried at runtime from any client via the `agent_bridge_guide` MCP tool — useful for agents that don't load skill files.

---

## Channels

Channels are the bidirectional messaging layer of open-agent-bridge. They let any agent or client session — Claude Code, OpenCode, Codex, Gemini CLI, the dashboard — send and receive structured conversational messages through the registry, with full delivery tracking and SQLite persistence.

This is the core feature of the project. Everything else (MCP tools, bridge daemons, dashboard chat) is built on top of it.

### Conversation model

Every message belongs to a **conversation** identified by a `conversationId`. A conversation is a thread of related turns between two parties — like a back-and-forth between Claude Code and Codex.

```
Conversation abc-123
  ├── Message m1  from: client-dashboard-ui  to: client-codex-bridge-xyz  "Review routes.ts"
  ├── Ack     a1  state: delivered_to_bridge
  ├── Message m2  from: client-codex-bridge-xyz  to: client-dashboard-ui  "Found 2 issues…"
  └── Ack     a2  state: answered
```

Key properties:
- `conversationId` is stable for the entire thread — use it to continue an existing conversation.
- `replyTo` links a message to the specific `messageId` it responds to.
- `expectsResponse: true` marks a message as pending until a reply arrives. In MCP sends, the adapter **defaults to `true`** when you omit the field (agent-to-agent messages are a conversation, not a log stream). Only explicit fire-and-forget markers in the text — `FYI`, `no reply`, `sin respuesta`, `just letting you know`, etc. — downgrade it to `false`. Pass the flag explicitly for deterministic behavior.
- `requiresAck: true` requests an explicit delivery acknowledgement from the recipient.
- All messages and ACKs are persisted in SQLite and survive registry restarts.

### Message payload

```typescript
interface ChannelMessage {
  conversationId:   string;    // Thread identifier — stable per conversation
  messageId:        string;    // Unique per message (UUID)
  fromAgentId:      string;    // Sender's registry ID (required)
  fromAgentName?:   string;    // Human-readable sender name
  toAgentId?:       string;    // Recipient's registry ID (omit for broadcast)
  replyTo?:         string;    // messageId this turn responds to
  taskId?:          string;    // Optional task association
  kind:             "chat" | "task_request" | "task_result" | "ack" | "error" | "presence";
  content:          string;    // Message body
  meta?:            Record<string, unknown>;  // Arbitrary metadata
  createdAt:        number;    // Unix ms timestamp (set by registry)
  expiresAt?:       number;    // Expiry timestamp in ms
  requiresAck?:     boolean;   // Request delivery acknowledgement
  expectsResponse?: boolean;   // Sender awaits a reply (default true; FYI markers downgrade to false)
  attemptCount?:    number;    // Delivery attempt counter (for retries)
}
```

### Delivery states

Each message transitions through delivery states tracked via `ChannelAck` records:

```
queued
  └─→ delivered_to_bridge       (bridge daemon received it)
        └─→ displayed_to_client (client session received it)
              ├─→ answered       (recipient replied)
              └─→ failed         (delivery or reply failed)
```

ACK records carry: `conversationId`, `messageId`, `state`, `actorId`, `actorType` (`registry | bridge | client | agent`), and `timestamp`.

### MCP tool reference

These are the five tools Claude Code gets after configuring open-agent-bridge as an MCP server.

#### `agent_bridge_guide`

Read the usage guide exposed by the MCP server itself. This is the quickest way for an agent to refresh the protocol contract without relying on external docs.

```
Parameters:
  topic?  "overview" | "setup" | "send" | "reply" | "acks" | "troubleshooting" | "all"
          Section to return (default: "all")
```

#### `list_agents`

Discover what agents and client sessions are currently connected.

```
Parameters:
  skill?        string   — Filter to agents that expose this skill
  project?      string   — Filter by project name or path substring
  healthyOnly?  boolean  — Only show healthy agents (default: true)
  includeClients? boolean — Include passive client sessions (default: false)
```

#### `message_client_session`

Send a channel message to a client session. The tool resolves the best target automatically.

```
Parameters:
  message       string   — Message body (required)
  project?      string   — Project name or path to identify the target session
  clientId?     string   — Exact agentId of the target (skips all resolution)
  clientType?   string   — Disambiguate when a project has multiple sessions
                           ("claude-code" | "opencode" | "codex" | "gemini")
  conversationId? string — Continue an existing conversation thread
  replyTo?      string   — messageId this message responds to
  taskId?       string   — Associate with a task
  expectsResponse? boolean — Whether you expect a reply. Default: true. Only explicit
                           FYI/no-reply markers in the text downgrade it to false.
  timeoutMs?    number   — Ms before the message expires without a reply
```

`expectsResponse` controls whether the receiver should answer:
- **Default is `true`.** Agent-to-agent channel messages are a conversation contract — the receiver should reply unless the sender opts out. A bare `"hola"` or `"build done"` will wake up OpenCode/Codex/Gemini's bridge with a "reply required" injection prompt, and Claude Code will surface it as a pending conversation.
- **Pass `false`** (or include explicit FYI markers — `FYI`, `no reply`, `sin respuesta`, `just letting you know`, `for your information`, `no need to reply`) for fire-and-forget. The bridge daemon will inject the message as **informational** context and suppress the receiver's outbound reply.
- For deterministic workflows pass the flag explicitly — text inference is a convenience for proactive sends, not a contract.

The mapping from message text to the boolean lives in [`inferExpectsResponse`](src/mcp/adapter.ts) and is unit-tested under `src/__tests__/peer-type-label.test.ts`.

**Target resolution order:**
1. `clientId` provided → direct lookup, no further resolution
2. No `clientId` and no `project`, but `conversationId` provided → resolves from conversation history
3. `project` provided → filter by project path/name match
4. Multiple matches → sorted by client type priority: bridge daemons first (`app-server-bridge`, `acp-bridge`, `opencode-plugin-bridge`), then `claude-code` > `claude` > `opencode` > `gemini-cli` > `gemini` > `codex-cli` > `codex`

Returns: `toAgentId`, `conversationId`, `messageId`, `deliveryState`.

#### `channel_inbox`

Inspect pending conversations — messages that arrived but haven't been replied to yet.

```
Parameters:
  pendingOnly?    boolean — Only show conversations awaiting reply (default: true)
  expiredOnly?    boolean — Only show conversations past their expiry
  limit?          number  — Max conversations when pendingOnly=false (default: 10)
  includeMessages? boolean — Include full message history per conversation
```

Returns an array of conversation entries. Each entry includes a `replyWith` object with the exact values to pass to `reply`:

```json
{
  "conversationId": "abc-123",
  "status": "pending",
  "lastMessagePreview": "Review src/api/routes.ts for N+1 queries",
  "replyWith": {
    "agentId": "client-codex-bridge-xyz",
    "conversationId": "abc-123",
    "replyTo": "msg-456"
  }
}
```

#### `reply`

Respond to a pending channel message. Use the `replyWith` values from `channel_inbox`.

```
Parameters:
  agentId        string  — fromAgentId of the message you're replying to (required)
  conversationId string  — conversationId from channel_inbox replyWith (required)
  replyTo        string  — messageId from channel_inbox replyWith (required)
  message        string  — Your reply content (required)
  taskId?        string  — Task association (optional)
  skillId?       string  — Fallback skill for task invocation (optional)
```

### HTTP API

The registry exposes a REST API at `http://localhost:4999`.

**Agent management:**

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/agents` | Register a new agent |
| `DELETE` | `/agents/:id` | Deregister an agent |
| `POST` | `/agents/:id/heartbeat` | Update agent heartbeat |
| `GET` | `/agents` | List all registered agents |
| `GET` | `/agents/:id` | Get a single agent by ID |
| `POST` | `/agents/:id/message` | Relay a task message to a specific agent |
| `POST` | `/agents/:id/ag-ui` | Proxy AG-UI SSE stream for a specific agent |
| `GET` | `/health` | Registry liveness check |

**Channel operations:**

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/channel/messages` | Create and broadcast a new channel message |
| `POST` | `/channel/acks` | Record a delivery acknowledgement |
| `GET` | `/channel/conversations` | List conversations (`?pending=true` for pending only) |
| `GET` | `/channel/conversations/:id` | Full conversation snapshot with messages and ACKs |
| `POST` | `/channel/conversations/:id/suppress` | Hide a conversation from inbox listings |
| `DELETE` | `/channel/conversations/:id/suppress` | Restore a suppressed conversation |
| `POST` | `/channel/messages/:convId/:msgId/retry` | Re-deliver a message (increments `attemptCount`) |
| `POST` | `/notify-claude` | Shorthand: send a channel notification to a Claude Code session |

**Create a message (POST `/channel/messages`):**

```json
{
  "fromAgentId": "my-agent-id",
  "toAgentId": "client-dashboard-ui",
  "kind": "chat",
  "content": "Task complete. Found 3 endpoints.",
  "conversationId": "abc-123",
  "replyTo": "msg-456",
  "expectsResponse": false,
  "requiresAck": true
}
```

### WebSocket events

Connect to `ws://localhost:4999/ws` to receive real-time channel events. Send `{ "type": "identify", "agentId": "<your-id>" }` immediately after connecting to enable targeted delivery.

| Event type | Payload | When |
| :--- | :--- | :--- |
| `channel.message` | `ChannelMessage` | A new message was posted to the registry |
| `channel.ack` | `ChannelAck` | A delivery state changed |
| `channel.conversation.suppressed` | `{ conversationId }` | A conversation was hidden |
| `channel.conversation.revived` | `{ conversationId }` | A suppressed conversation was restored |

> **Targeted delivery:** If a message has `toAgentId`, the registry delivers it directly to that agent's WS connection before broadcasting to all subscribers.

### End-to-end example

Claude Code asks Codex to review a file, waits for the answer, and closes the thread:

```
# Step 1 — discover what's connected
list_agents
→ "codex" session active on project /projects/my-app

# Step 2 — send the request
message_client_session(
  project: "my-app",
  message: "Review src/api/routes.ts for N+1 queries",
  expectsResponse: true,
  timeoutMs: 120000
)
→ conversationId: "abc-123", messageId: "msg-001", deliveryState: "queued"

# Step 3 — Codex processes the turn via app-server bridge, sends reply
# (happens automatically via CodexAppServerBridge → turn/start JSON-RPC)

# Step 4 — check the inbox
channel_inbox
→ conversationId: "abc-123", status: "pending"
  lastMessagePreview: "Found 2 N+1 issues in getUserPosts() and..."
  replyWith: { agentId: "client-codex-bridge-xyz", conversationId: "abc-123", replyTo: "msg-002" }

# Step 5 — acknowledge and close the thread
reply(
  agentId: "client-codex-bridge-xyz",
  conversationId: "abc-123",
  replyTo: "msg-002",
  message: "Thanks, applying the fix now."
)
→ Reply sent. Conversation answered.
```

---

## Client bridges

Each AI client has a different bridge mechanism depending on how it receives channel messages. All clients ultimately use the same channel protocol — what differs is *how the message surfaces to the human*.

### Claude Code bridge (push)

Claude Code's bridge is **built into the MCP adapter itself** — no separate daemon required.

When Claude Code connects to open-agent-bridge via MCP, the `McpAgentBridge` intercepts the MCP `initialize` handshake. It reads the client name (`Claude Code`, version, workspace roots), builds a stable `agentId` (`client-claude-code-{hash}`), and registers it as a client session in the registry automatically.

From that point on, any channel message addressed to that `agentId` is **pushed** to the Claude terminal as an MCP notification:

```
Incoming channel message
  → ChannelClientRuntime receives channel.message event via WS
  → ClaudeClientProfile.mapChannelMessage() formats it
  → server.notification({ method: "notifications/claude/channel", params: { content, meta } })
  → Claude terminal renders a <channel> block inline
```

What Claude sees in its terminal:

```xml
<channel source="open-agent-bridge" from_agent="my-agent-id" conversation_id="abc-123" message_id="msg-001">
  Task complete. Found 3 N+1 queries in getUserPosts().
</channel>
```

Claude then uses the `reply` MCP tool to respond, closing the conversation thread.

**Delivery ACKs sent automatically:**
1. `delivered_to_bridge` — MCP adapter received the message
2. `displayed_to_client` — notification push to Claude succeeded

If Claude Code is not yet connected when a message arrives, the adapter buffers up to 100 messages and replays them on `initialize`.

**Sending to Claude Code from another agent** — use the `notify-claude` skill or `POST /notify-claude`:

```bash
# From any AgentServer via notify-claude skill
{
  "targetProject": "/path/to/my-project",
  "content": "Build finished. 3 tests failed in auth module.",
  "expectsResponse": true
}

# Or directly via HTTP
POST http://localhost:4999/notify-claude
{
  "agentId": "my-agent",
  "toAgentId": "client-claude-code-abc123",
  "content": "Build finished. 3 tests failed in auth module.",
  "conversationId": "conv-xyz",
  "expectsResponse": true
}
```

---

### OpenCode bridge (plugin push)

OpenCode's bridge is a local plugin installed by:

```bash
pnpm run dev -- opencode install-plugin --project /path/to/opencode-project
# or, after build/install:
open-agent-bridge opencode install-plugin --project /path/to/opencode-project
```

The installer copies the bridge plugin into `.opencode/plugins/agent-bridge.ts`. For global use it writes to `~/.config/opencode/plugins/agent-bridge.ts`. OpenCode auto-scans local plugins, so the installer does not need to mutate `opencode.json` for plugin registration.

At runtime the plugin:

1. Registers a client row named like `<project> (opencode bridge)` with `clientVersion: "opencode-plugin-bridge"`.
2. Identifies its WebSocket as `client-opencode-bridge-{hash}` so the registry can target it directly.
3. Tracks the active OpenCode session from `session.created`, `session.updated`, and `session.idle` events.
4. Injects inbound channel messages with `ctx.client.session.prompt_async`.
5. Sends delivery ACKs and periodically re-syncs missed pending messages from `/channel/conversations`.

The injected prompt mirrors the Codex/Gemini format. If `expectsResponse !== false`, OpenCode receives a "reply required" turn with the exact `agent-bridge.reply` fields to copy. Informational messages are marked "no reply" and tell the receiving agent not to call `reply`.

OpenCode can also connect to the MCP adapter as a normal MCP client. In that case `OpenCodeClientProfile` accepts direct messages for the OpenCode MCP session and sibling bridge messages for the same project, so `channel_inbox(pendingOnly=true)` still works even when auto-routing chooses the plugin bridge.

---

### Codex bridge (app-server)

The Codex bridge runs as a **separate daemon** (`CodexAppServerBridge`) that connects the channel layer to the Codex app-server JSON-RPC protocol:

1. Connects to the Codex app-server WebSocket (`ws://127.0.0.1:4500`)
2. Performs the `initialize` handshake
3. Registers as a client session in the registry (`clientName: "codex"`, `clientVersion: "app-server-bridge"`)
4. On incoming `channel.message`: calls `turn/start` on the app-server — Codex processes it as a real prompt turn
5. Codex's reply is sent back through the channel

This is the preferred path when Codex is active: `message_client_session` automatically routes to the bridge (priority `-1`) over the Codex TUI MCP client.

**One-command startup (registry + bridge + Codex TUI):**

```bash
pnpm run dev -- codex start --project /path/to/codex-project
```

**Bridge daemon only:**

```bash
pnpm run dev -- codex app-bridge --project /path/to/codex-project
# Start Codex separately with: codex --remote ws://127.0.0.1:4500
```

**tmux fallback** — when the app-server is not available, inject follow-up prompts into the active Codex pane:

```bash
pnpm run dev -- codex tmux-bind      # bind current tmux pane to this session
pnpm run dev -- codex tmux-sidecar   # poll and inject pending channel messages
```

**Troubleshooting — `delivered_to_bridge` stuck without a Codex TUI**

If Claude Code (or any sender) sees status `delivered_to_bridge` for a Codex peer but Codex never picks the turn up, the most common cause is that the Codex TUI is running in **isolated mode** (plain `codex`) instead of attached to the bridge's app-server. The bridge daemon's app-server has nothing to inject into. Fix by either:

```bash
# Option A — let the bridge launch and attach Codex for you
pnpm run dev -- codex start --project /path/to/codex-project

# Option B — start the bridge separately, then attach Codex manually
pnpm run dev -- codex app-bridge --project /path/to/codex-project
codex --remote ws://127.0.0.1:4500
```

The inner MCP client of an isolated `codex` session still registers with the registry, so `channel_inbox(pendingOnly=true)` will surface the message — but the agent has to call it manually instead of receiving an automatic turn injection. The full diagnosis ladder lives in the `agent-bridge` skill.

---

### Gemini bridge (ACP)

Gemini CLI exposes an `--acp` mode that communicates over JSON-RPC 2.0 on stdin/stdout. `GeminiAcpBridge` uses this to drive Gemini programmatically — the same pattern as the Codex app-server bridge:

1. Spawns `gemini --acp` as a subprocess.
2. Sends `initialize` + `session/new` handshake.
3. Registers as a client in the registry (`clientName: "gemini"`, `clientVersion: "acp-bridge"`).
4. On incoming `channel.message` → calls `session/prompt` on the ACP session.
5. Gemini processes the turn and responds; the reply is sent back through the channel.

Permission requests from Gemini (`session/request_permission`) are auto-approved by the bridge.

**One-command startup (registry + ACP bridge):**

```bash
open-agent-bridge gemini start --project "/absolute/path/to/your/project"
```

**Bridge daemon only:**

```bash
open-agent-bridge gemini app-bridge --project "/absolute/path/to/your/project"
```

Available options: `--registry-url <url>`, `--gemini-command <cmd>` (default: `gemini`), `--debug`.

**Queue behaviour:** up to 10 messages are buffered while Gemini is mid-turn; each is retried up to 3 times with a 5 s delay.

### Gemini bridge (tmux fallback)

When `gemini --acp` is not available, fall back to tmux pane injection:

```bash
pnpm run dev -- gemini tmux-bind     # bind current tmux pane to this Gemini session
pnpm run dev -- gemini tmux-sidecar  # poll channel inbox and inject follow-ups as keystrokes
```

---

### Injection prompt format (OpenCode / Codex / Gemini)

The Codex and Gemini bridge daemons share a single prompt template (`src/client/injection-prompt.ts`) that wraps every inbound channel message before injecting it as a turn. The OpenCode plugin carries the same contract in its local plugin file. The wrapper exists so the receiving LLM can identify the sender, see the full content delimited from instructions, and copy a pre-filled `reply` call without having to derive any IDs.

A reply-required injection looks like this:

```
[open-agent-bridge] Channel message — reply required
===============================================
From:          rcm-worker (3fdb0c6a)
Conversation:  7734035a-2c10-4626-5761-13f6d02f6e45
Message ID:    1d147308-a831-4525-aaf6-3c41614d5a20

----- BEGIN MESSAGE -----
<sender's content>
----- END MESSAGE -----

▶ Respond to the sender NOW with the agent-bridge MCP. The sender is
  waiting on this turn — silence will block them.

Tool call (copy each field verbatim — the adapter handles routing):

  agent-bridge.reply
    agentId:        "client-claude-code-2d1c3fdb0c6a"
    conversationId: "7734035a-2c10-4626-5761-13f6d02f6e45"
    replyTo:        "1d147308-a831-4525-aaf6-3c41614d5a20"
    message:        "<your answer here>"

How to compose the reply:
  1. Do any local work the sender's message implies …
  2. Put your answer or finding in the `message` field.
  ...
```

When `expectsResponse` resolves to `false` (sender opted into FYI), the header switches to `Channel message — informational (no reply)` and the prompt instructs the receiver to NOT call `reply`. Claude Code peers do **not** receive this wrapper — they get a raw `<channel>` push event and decide what to do based on conversation context.

Test contract: `src/__tests__/injection-prompt.test.ts` locks the structure (BEGIN/END markers, literal IDs in the call template, header wording) so future edits don't silently regress it.

---

### Delivery mode comparison

| Client | Bridge type | How messages arrive | Requires daemon |
| :--- | :--- | :--- | :--- |
| **Claude Code** | Built-in MCP push | `<channel>` block in terminal via `notifications/claude/channel` | No — part of MCP adapter |
| **OpenCode** | Local plugin bridge | `session.prompt_async` → OpenCode processes as a prompt turn | No separate process — plugin runs inside OpenCode |
| **Codex** | App-server daemon | `turn/start` JSON-RPC → Codex processes as a prompt turn | Yes — `codex app-bridge` |
| **Gemini CLI** | ACP bridge (preferred) | `session/prompt` JSON-RPC → Gemini processes as a prompt turn | Yes — `gemini app-bridge` |
| **Gemini CLI** | tmux sidecar (fallback) | Keystrokes injected into the active tmux pane | Yes — `gemini tmux-sidecar` |
| **Dashboard** | WebSocket | Chat panel updates via `channel.message` WS event | No — built into registry WS |

All paths share the same channel protocol (`ChannelMessage`, `ChannelAck`, `conversationId`). The bridge layer is just the last-mile delivery mechanism.

---

## Dashboard

The dashboard is a Vue 3 SPA served by the registry at `http://localhost:4999/dashboard`. It shows live agent status, channel conversations, and task events.

Build the dashboard:

```bash
pnpm run build:dashboard
# or build everything at once
pnpm run build:all
```

Open in the browser:

```bash
pnpm run dev -- dashboard
# Dashboard: http://localhost:4999/dashboard
```

The dashboard connects to the registry WebSocket for live updates. Pass `--no-open` to print the URL without launching a browser. For hot-reload development use `pnpm run dev:dashboard` (Vite on `:5173`).

---

## Skills

### Built-in skills

Always available on every `AgentServer`, regardless of project type.

| Skill | Description |
| :--- | :--- |
| `file-search` | Find files by glob pattern within the project directory. |
| `endpoint-find` | Detect HTTP endpoints in backends or API calls in frontends. |
| `code-query` | Search source code by text or regex. |
| `prompt-execute` | Render a prompt template with variables and return the result. |
| `notify-claude` | Send a notification to a Claude Code terminal via the channel. |
| `shell-execute` | Run an arbitrary shell command in the project directory. |

### Auto-detected skills

Activated based on files found in the project root at startup.

| Skill | Activation condition | Requires `--claude` |
| :--- | :--- | :--- |
| `run-script` | `package.json` present | No |
| `run-tests` | Jest, Vitest, pytest, or `pom.xml` detected | No |
| `docker-build` | `Dockerfile` present | No |
| `code-review` | `src/` directory present (uses Claude Code AI backend) | **Yes** |
| `claude-execute` | Always registered when `--claude` is active | **Yes** |

---

## CLI reference

All commands run via `node dist/cli/index.js <command>` (built) or `pnpm run dev -- <command>` (source).

| Command | Description |
| :--- | :--- |
| `start [path]` | Start an agent server for the given directory (defaults to `.`). |
| `registry start` | Start the registry on `:4999`. |
| `registry status` | Query registry health and agent count. |
| `list` | List all active agents. |
| `health [agent-id]` | Check reachability of one or all agents. |
| `ask <agent> <message>` | Send a one-shot task to a specific agent. |
| `find <query>` | Search agents by skill or project type. |
| `delegate <skill-id> <message>` | Send a task to the healthiest agent exposing a given skill. |
| `broadcast <message>` | Send a message to all healthy agents. |
| `mcp start` | Start the MCP adapter in `stdio` mode (used by Claude Code, OpenCode, Codex, Gemini, and other MCP clients). |
| `mcp config [--write] [--global]` | Print or write `.mcp.json` configuration. |
| `mcp status` | Show live agents and registered MCP tools. |
| `mcp server` | Start the MCP adapter in HTTP/SSE mode (port 6000). |
| `opencode install-plugin` | Install the local OpenCode plugin bridge into a project or globally. |
| `codex start` | One-command: registry + bridge + Codex TUI. |
| `codex app-bridge` | Start the Codex app-server bridge daemon only. |
| `codex tmux-bind` | Bind the current tmux pane to the active Codex session. |
| `codex tmux-sidecar` | Poll and inject pending channel messages into a tmux pane. |
| `gemini start` | One-command: registry + Gemini ACP bridge. |
| `gemini app-bridge` | Start the Gemini ACP bridge daemon only (`gemini --acp`). |
| `gemini tmux-bind` | Bind the current Gemini CLI session to a tmux pane (tmux fallback). |
| `gemini tmux-sidecar` | Poll and inject pending channel messages into a Gemini tmux pane (tmux fallback). |
| `dashboard` | Print or open the dashboard URL in the browser. |

---

## Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `build` | `tsc` + plugin copy | Compile TypeScript to `dist/` and copy the OpenCode plugin files into `dist/client/opencode-plugin/`. |
| `dev` | `tsx src/cli/index.ts` | Run CLI from source without building. |
| `start` | `node dist/cli/index.js` | Run the compiled CLI. |
| `clean` | `rm -rf dist` | Delete build output. |
| `build:dashboard` | `cd dashboard && pnpm run build` | Build the Vue dashboard SPA. |
| `build:all` | `build` + `build:dashboard` + copy | Full production build including dashboard. |
| `dev:dashboard` | `cd dashboard && pnpm run dev` | Vite hot-reload dev server for the dashboard. |
| `test` | `vitest run` | Run all unit tests once. |
| `lint` | `biome check src/` | Lint and check code style with Biome. |
| `lint:fix` | `biome check src/ --write` | Auto-fix lint issues. |

---

## Architecture

```
src/
├── agent/
│   ├── server.ts              AgentServer: HTTP + WS + A2A JSON-RPC + AG-UI SSE
│   ├── handlers.ts            TaskStore, RequestRouter, skill inference
│   ├── card.ts                A2A AgentCard builder
│   ├── project-detector.ts    Project type detection from filesystem
│   └── ag-ui-events.ts        AG-UI SSE event helpers
├── cli/
│   ├── index.ts               CLI entrypoint (Commander)
│   └── commands/              One file per CLI sub-command
├── client/
│   ├── a2a-client.ts                A2AClient: HTTP + WS client for agent-to-agent calls
│   ├── registry-client.ts           RegistryClient: HTTP client for the registry REST API
│   ├── client-profile-resolver.ts   Resolves delivery profile by client type (Claude/OpenCode/Codex/Gemini)
│   ├── conversation-session-store.ts In-memory conversation state with ACK tracking
│   ├── codex-app-server-bridge.ts   CodexAppServerBridge daemon
│   ├── codex-app-server-client.ts   WS client for the Codex app-server protocol
│   ├── codex-runtime-discovery.ts   Detect running Codex process
│   ├── codex-session-files.ts       Read/write active Codex session marker
│   ├── codex-tmux.ts                Low-level tmux pane helpers for Codex
│   ├── codex-tmux-bridge-service.ts tmux-based Codex injection sidecar
│   ├── gemini-acp-client.ts         JSON-RPC 2.0 client for `gemini --acp` (spawns process)
│   ├── gemini-acp-bridge.ts         Full ACP bridge daemon (spawn + register + inject + reply)
│   ├── gemini-runtime-discovery.ts  Detect running Gemini CLI process
│   ├── gemini-session-files.ts      Read/write active Gemini session marker
│   ├── gemini-tmux-bridge-service.ts tmux-based Gemini injection sidecar (fallback)
│   ├── opencode-plugin/             OpenCode local plugin source copied by `opencode install-plugin`
│   ├── channel-transport.ts         WebSocket transport to registry
│   ├── channel-client-runtime.ts    WS runtime with reconnect + event bus
│   ├── conversation-service.ts      High-level send/reply/inbox helpers
│   └── profiles/                    Client behavior profiles (Claude, OpenCode, Codex, Gemini)
├── mcp/
│   └── adapter.ts             McpAgentBridge — 5 MCP tools + session resolution
├── registry/
│   ├── server.ts              RegistryServer: HTTP + WebSocket hub (:4999)
│   ├── store.ts               AgentStore: in-memory only (not persisted across restarts)
│   ├── channel-store.ts       SQLite persistence for channel messages and ACKs
│   └── events.ts              RegistryEventBus
├── skills/
│   ├── framework.ts           BaseSkill, SkillRegistry
│   ├── state-graph.ts         StateGraph for multi-step skill workflows
│   └── builtins/              Built-in and auto-detected skill implementations
└── types/
    ├── a2a.ts                 A2A spec types (AgentCard, Task, etc.)
    ├── messages.ts            Registry wire types (AgentMessage, ChannelMessage, etc.)
    └── skills.ts              Skill context and I/O types
```

**Persistence:** channel messages and ACKs are stored in SQLite at `.open-agent-bridge/registry.sqlite` across three tables: `channel_messages`, `channel_acks`, and `channel_suppressed_conversations`. SQLite access uses the `node:sqlite` built-in module (Node 22+) — there is no external SQLite dependency. The `AgentStore` (registered agents and heartbeats) is in-memory only and resets on registry restart; agents re-register automatically on reconnect.

**AgentServer — A2A JSON-RPC methods:**

| Method | Description |
| :--- | :--- |
| `tasks/send` | Submit a task to the agent (synchronous response) |
| `tasks/get` | Poll the status of an in-flight task |
| `tasks/cancel` | Cancel a running task |
| `agent.health` | Liveness check (returns uptime, version, skill count) |
| `agent.hello` | Handshake — returns agent name, project, and capabilities |
| `project.info` | Project metadata: type, framework, category |
| `project.files` | List files matching a glob pattern |
| `project.search` | Full-text / regex search across project files |

---

## Feature status

| Feature | Status |
| :--- | :--- |
| Registry HTTP + WS + SQLite | stable |
| MCP adapter — 5 tools | stable |
| Claude Code push bridge | stable |
| OpenCode plugin push bridge | stable |
| Codex app-server bridge | stable |
| Gemini ACP bridge | stable |
| Dashboard Vue SPA | stable |
| 6 built-in skills | stable |
| HTTP SSE MCP mode (`mcp server`, port 6000) | stable |
| Dynamic skills (run-script, run-tests, docker-build, code-review) | stable — require `--claude` |
| `tasks/sendSubscribe` — A2A SSE streaming | **stub — not implemented** |
| StateGraph skill composition | implemented, unused in production |
| Gemini tmux fallback | experimental |
| `ask --stream` CLI flag | declared, not implemented |

---

## Testing

```bash
pnpm run test   # vitest — runs all 11 test files once
pnpm run lint   # biome — lint and style check
```

Test coverage includes: injection prompt contract (`injection-prompt.test.ts`), peer-type label generation (`peer-type-label.test.ts`), `inferExpectsResponse` text inference, conversation ID determinism, ACK state transitions, and MCP adapter routing.

---

## Limitations

- **Local only.** The registry, agents, and bridges all run on `localhost`. No remote or cloud deployment is supported in v0.1.
- **Single registry.** All agents must connect to the same registry instance. Multi-registry federation is not implemented.
- **No authentication.** All local connections are unauthenticated. Do not expose registry or agent ports beyond `localhost`.
- **Volatile agent registry.** The `AgentStore` is in-memory only. Restarting the registry clears all registered agents and heartbeats — agents re-register automatically on reconnect, but any in-flight state is lost. Only channel messages and ACKs (in `channel_messages`, `channel_acks`, `channel_suppressed_conversations`) are persisted to SQLite.
- **Codex bridge requires app-server remote TUI or tmux fallback.** The preferred path is `open-agent-bridge codex start` or `codex --remote ws://127.0.0.1:<port>` against the bridge app-server. A plain `codex` session is isolated and cannot receive automatic turn injection. The tmux sidecar fallback polls at a fixed interval and injects follow-ups as synthetic keypresses, which is inherently racy under heavy TUI use.
- **OpenCode push requires the local plugin.** OpenCode can call the MCP tools without the plugin, but automatic turn injection depends on `open-agent-bridge opencode install-plugin` and an OpenCode restart. Without the plugin bridge, inbound work must be discovered through `channel_inbox`.
- **Dashboard `handleChannelMessage` depends on `toAgentId` in broadcast.** When a channel message is broadcast without a `toAgentId`, the dashboard may not correctly attribute it to the right conversation in the UI — this is a known issue with the current broadcast routing in the registry WebSocket relay.
- **`tasks/sendSubscribe` not implemented.** End-to-end A2A streaming (Server-Sent Events per task) is not yet supported. The method is a stub — it is not announced in the Agent Card.
- **`ask --stream` flag is a no-op.** The `--stream` option is declared in the CLI but the handler never reads it. Streaming task output is not implemented.
- **Gemini tmux fallback is experimental.** The preferred Gemini path is the ACP bridge (`gemini --acp`). The `GeminiTmuxBridgeService` uses the same tmux injection mechanism as Codex and has the same caveats.

---

## Contributing

1. Fork the repository and create a feature branch.
2. Run `pnpm install` and `pnpm run build` to verify the build.
3. Run `pnpm run test` (Vitest) and `pnpm run lint` (Biome) before committing.
4. Open a pull request describing the change and its motivation.

---

## License

MIT
