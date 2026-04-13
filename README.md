# agent-bridge

<!-- TODO: Add SVG logo/hero image here -->

<div style="text-align: center;">
  <img alt="version" src="https://img.shields.io/badge/version-0.1.0-blue?style=for-the-badge" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=for-the-badge&logo=node.js" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey?style=for-the-badge" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178c6?style=for-the-badge&logo=typescript" />
</div>

**Let Claude Code, Codex, and Gemini CLI talk to each other — over MCP, locally, bidirectionally.**

`agent-bridge` is a local communication hub for AI agents. It provides service discovery, bidirectional messaging, and MCP tool exposure so that Claude Code, Codex, and Gemini CLI running in separate projects can delegate tasks, exchange context, and coordinate work without leaving the local machine.

---

<details>
<summary><strong>Table of Contents</strong></summary>

- [TL;DR — 60-second quickstart](#tldr--60-second-quickstart)
- [Why agent-bridge?](#why-agent-bridge)
- [How it works](#how-it-works)
- [Getting started](#getting-started)
  - [Requirements](#requirements)
  - [Install](#install)
  - [1. Start the registry](#1-start-the-registry)
  - [2. Start an agent](#2-start-an-agent)
  - [3. Configure MCP](#3-configure-mcp)
- [MCP integration](#mcp-integration)
  - [.mcp.json](#mcpjson)
  - [Available tools](#available-tools)
  - [Channel protocol](#channel-protocol)
- [Codex bridge](#codex-bridge)
- [Dashboard](#dashboard)
- [Skills](#skills)
  - [Built-in skills](#built-in-skills)
  - [Auto-detected skills](#auto-detected-skills)
- [CLI reference](#cli-reference)
- [Scripts](#scripts)
- [Architecture](#architecture)
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

# 5. Restart Claude Code — it now has 4 MCP tools
```

Claude Code now has four MCP tools: `list_agents`, `channel_inbox`, `message_client_session`, `reply`.

---

## Why agent-bridge?

- **Local-first, zero infrastructure.** Everything runs on `localhost`. No cloud relay, no auth tokens, no subscriptions. The registry binds to `:4999`; agents bind to `:5001+`.
- **Native MCP integration.** Exposes the agent network as first-class MCP tools via `stdio` transport, so Claude Code picks them up automatically from `.mcp.json` without any plugin or wrapper.
- **Bidirectional channel, not fire-and-forget.** Messages carry a `conversationId`, delivery ACKs are tracked in SQLite, and the `reply` tool closes the loop back to the sender. Claude Code can ask Codex a question and receive the answer in the same conversation thread.
- **Codex app-server bridge.** `CodexAppServerBridge` injects incoming channel messages directly into the Codex app-server via `turn/start` JSON-RPC, so Codex actually processes requests rather than just receiving raw text.

---

## How it works

```
Claude Code / Codex / Gemini CLI / Dashboard
              |
              v
    ┌─────────────────────────────────────┐
    │       RegistryServer :4999          │
    │  HTTP  /agents /health /channels    │
    │  WS    /ws  (relay + broadcast)     │
    │  SQLite .agent-bridge/registry.sqlite│
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
```

All three runtime components — `AgentServer`, `McpAgentBridge`, and `CodexAppServerBridge` — connect independently to the registry. None depends on the others being present.

**Message flow — Claude Code delegates a task to Codex:**

```plaintext
# sequence
Claude Code
  calls message_client_session MCP tool
  McpAgentBridge posts ChannelMessage to RegistryServer /channels
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
- (Optional) `codex` CLI in `$PATH` for Codex bridge features
- (Optional) `gemini` CLI in `$PATH` for Gemini bridge features

### Install

```bash
git clone <repo-url>
cd agent-bridge
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
| `http://localhost:4999` | HTTP REST (`/agents`, `/health`, `/channels`) |
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

## MCP integration

### .mcp.json

`agent-bridge mcp config` generates the `.mcp.json` entry. The `AGENT_BRIDGE_PROJECT` environment variable tells the MCP adapter which project to associate the Claude Code session with:

```json
{
  "mcpServers": {
    "agent-bridge": {
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
    "agent-bridge": {
      "command": "pnpm",
      "args": ["dlx", "agent-bridge", "mcp", "start"],
      "env": {
        "AGENT_BRIDGE_PROJECT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

The `mcp config` command writes absolute paths for the current machine. Commit the result to the project or add it to your global Claude Code settings.

### Available tools

| Tool | Description |
| :--- | :--- |
| `list_agents` | Discover connected agents and client sessions. Excludes dashboard and bridge daemons (internal routing details). |
| `channel_inbox` | Inspect pending channel conversations with full context and a `replyWith` hint for responding. |
| `message_client_session` | Send a message to a named client session. Automatically resolves the best target — the bridge daemon is preferred when present. |
| `reply` | Respond to an incoming channel message, correlating by `conversationId`. |

Check live tool and agent status at any time:

```bash
pnpm run dev -- mcp status
```

### Channel protocol

Every inter-agent message travels as a `ChannelMessage`. The full payload shape:

```typescript
interface ChannelMessage {
  conversationId:    string;   // Groups related turns (stable per thread)
  messageId:         string;   // Unique per message
  replyTo?:          string;   // messageId this is responding to
  fromAgentId:       string;   // Sender's registry ID
  toAgentId?:        string;   // Recipient's registry ID (omit for broadcast)
  kind:              "chat" | "task_request" | "task_result" | "ack" | "error" | "presence";
  content:           string;   // Human-readable payload
  createdAt:         number;   // Unix ms timestamp
  requiresAck?:      boolean;  // Request delivery acknowledgement
  expectsResponse?:  boolean;  // Sender is awaiting a reply turn
}
```

Delivery state progression tracked per message via `ChannelAck`:

```
queued  ->  delivered_to_bridge  ->  displayed_to_client  ->  answered
                                                          `->  failed
```

The registry stores these states in SQLite and exposes them via `GET /channels/:conversationId`.

---

## Codex bridge

The Codex bridge enables bidirectional messaging between Claude Code and Codex by running a daemon (`CodexAppServerBridge`) that:

1. Spawns `codex app-server --listen ws://127.0.0.1:4500`
2. Connects to it directly as a second WebSocket client and performs the initialize handshake
3. Registers as a client session in the registry (`clientVersion: "app-server-bridge"`)
4. Injects incoming `channel.message` events as Codex turns via `turn/start` JSON-RPC

**One-command startup (registry + bridge + Codex TUI):**

```bash
pnpm run dev -- codex start --project /path/to/codex-project
# starts embedded registry if none is running
# starts bridge daemon
# launches Codex TUI connected to the app-server
```

**Bridge daemon only:**

```bash
pnpm run dev -- codex app-bridge --project /path/to/codex-project
# Bridge running. Start Codex with:
#   codex --remote ws://127.0.0.1:4500
```

**tmux integration** — inject follow-up prompts into the active Codex pane:

```bash
# Bind the current tmux pane to the active Codex client session
pnpm run dev -- codex tmux-bind

# Poll and inject pending channel messages into the bound pane
pnpm run dev -- codex tmux-sidecar
```

> **Note:** If no `CodexAppServerBridge` is running, `message_client_session` falls back to the Codex TUI MCP client (which has a lower routing priority than the bridge daemon).

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

Activated based on files found in the project root at startup. Requires `--claude` flag.

| Skill | Activation condition |
| :--- | :--- |
| `run-script` | `package.json` present. |
| `run-tests` | Jest, Vitest, pytest, or `pom.xml` detected. |
| `docker-build` | `Dockerfile` present. |
| `code-review` | `src/` directory present (uses Claude Code AI backend). |
| `claude-execute` | Always registered when `--claude` is active. |

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
| `mcp start` | Start the MCP adapter in `stdio` mode (used by Claude Code). |
| `mcp config [--write] [--global]` | Print or write `.mcp.json` configuration. |
| `mcp status` | Show live agents and registered MCP tools. |
| `mcp server` | Start the MCP adapter in HTTP/SSE mode (port 6000). |
| `codex start` | One-command: registry + bridge + Codex TUI. |
| `codex app-bridge` | Start the Codex app-server bridge daemon only. |
| `codex tmux-bind` | Bind the current tmux pane to the active Codex session. |
| `codex tmux-sidecar` | Poll and inject pending channel messages into a tmux pane. |
| `gemini tmux-bind` | Bind the current Gemini CLI session to a tmux pane. |
| `gemini tmux-sidecar` | Poll and inject pending channel messages into a Gemini tmux pane. |
| `dashboard` | Print or open the dashboard URL in the browser. |

---

## Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `build` | `tsc` | Compile TypeScript to `dist/`. |
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
│   ├── codex-app-server-bridge.ts   CodexAppServerBridge daemon
│   ├── codex-app-server-client.ts   WS client for the Codex app-server protocol
│   ├── codex-tmux-bridge-service.ts tmux-based Codex injection sidecar
│   ├── gemini-tmux-bridge-service.ts tmux-based Gemini injection sidecar
│   ├── channel-transport.ts         WebSocket transport to registry
│   ├── channel-client-runtime.ts    WS runtime with reconnect + event bus
│   ├── conversation-service.ts      High-level send/reply/inbox helpers
│   └── profiles/                    Client behavior profiles (Claude, Codex, Gemini)
├── mcp/
│   └── adapter.ts             McpAgentBridge — 4 MCP tools + session resolution
├── registry/
│   ├── server.ts              RegistryServer: HTTP + WebSocket hub (:4999)
│   ├── store.ts               AgentStore: in-memory + SQLite registry
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

**Persistence:** channel messages and ACKs are stored in SQLite at `.agent-bridge/registry.sqlite` across three tables: `channel_messages`, `channel_acks`, and `channel_suppressed_conversations`.

---

## Limitations

- **Local only.** The registry, agents, and bridges all run on `localhost`. No remote or cloud deployment is supported in v0.1.
- **Single registry.** All agents must connect to the same registry instance. Multi-registry federation is not implemented.
- **No authentication.** All local connections are unauthenticated. Do not expose registry or agent ports beyond `localhost`.
- **SQLite registry store.** The `AgentStore` uses SQLite via `registry.sqlite`. Concurrent write throughput is bounded by SQLite's single-writer model.
- **Codex bridge requires tmux or app-server.** The tmux sidecar approach polls at a fixed interval and injects follow-ups as synthetic keypresses, which is inherently racy under heavy TUI use.
- **Dashboard `handleChannelMessage` depends on `toAgentId` in broadcast.** When a channel message is broadcast without a `toAgentId`, the dashboard may not correctly attribute it to the right conversation in the UI — this is a known issue with the current broadcast routing in the registry WebSocket relay.
- **`tasks/sendSubscribe` not implemented.** End-to-end A2A streaming (Server-Sent Events per task) is not yet supported.
- **Gemini bridge is experimental.** The `GeminiTmuxBridgeService` uses the same tmux injection mechanism as Codex and has the same caveats.

---

## Contributing

1. Fork the repository and create a feature branch.
2. Run `pnpm install` and `pnpm run build` to verify the build.
3. Run `pnpm run test` (Vitest) and `pnpm run lint` (Biome) before committing.
4. Open a pull request describing the change and its motivation.

---

## License

MIT
