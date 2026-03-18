# agent-bridge Dashboard — Architecture

## Overview

Vue 3 SPA that visualizes connected agents, traces task lifecycles, and enables interactive chat — all in real-time via WebSocket.

```
Browser (Vue 3 + Pinia + Vue Router)
  ├── Pinia stores consume ws://localhost:4999/ws
  ├── Chat panel talks directly to A2A agent HTTP endpoints
  └── Vite proxy forwards /ws, /agents, /events to registry in dev
```

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Framework | Vue 3 (Composition API) | Reactivity system ideal for real-time WS state |
| State | Pinia | Devtools support, TypeScript-first, modular |
| Routing | Vue Router 4 | Multi-view navigation (dashboard, agent detail) |
| Build | Vite 6 | Fast HMR, minimal config, static output |
| Styles | Tailwind CSS v4 | Utility-first, JIT, no purge config needed |
| WS utils | @vueuse/core `useWebSocket` | Auto-reconnect, reactive status, lifecycle hooks |
| Fonts | JetBrains Mono + IBM Plex Sans | Industrial/mission-control aesthetic |

## Architecture

### Data Flow

```
Registry WebSocket (:4999/ws)
  │
  ├── snapshot { agents[] }        ──▶ useRegistryStore.agents (Map)
  ├── agent.registered             ──▶ map.set(agentId, entry)
  ├── agent.deregistered/removed   ──▶ map.delete(agentId)
  ├── agent.heartbeat              ──▶ entry.lastHeartbeat updated
  ├── agent.unhealthy              ──▶ entry.healthy = false
  └── task.update                  ──▶ useTraceStore.events (circular buffer, 500)

Chat
  └── fetch POST → Agent A2A HTTP (:500x)
        └── JSON-RPC tasks/send
              └── Response → ChatMessage
```

### Stores (Pinia)

#### `useRegistryStore` (`src/stores/registry.ts`)
- Connects to `ws://localhost:4999/ws` via `useWebSocket`
- Manages `Map<agentId, RegistryAgent>` — reactive to WS events
- Auto-reconnects with exponential backoff (1s → 2s → 4s … max 30s)
- Exposes: `agentList`, `agentCount`, `healthyCount`, `status`, `getAgent(id)`

#### `useTraceStore` (`src/stores/trace.ts`)
- Also listens on registry WS for `task.update` events
- Maintains circular buffer (max 500 events, newest first)
- Filterable by: `agentId`, `skillId`, `state`
- Exposes: `filteredEvents`, `filters`, `setFilter()`, `clearFilters()`, `toggleExpanded()`

#### `useChatStore` (`src/stores/chat.ts`)
- Manages selected agent + message history
- Sends A2A JSON-RPC `tasks/send` via `fetch()` to agent URL
- Handles response artifacts and formats for display
- Exposes: `messages`, `selectedAgent`, `isStreaming`, `sendMessage()`, `selectAgent()`

### Router

Hash-based routing (works when served at any path):

| Route | View | Purpose |
|-------|------|---------|
| `/` | `DashboardView` | 3-panel: agents / trace / chat |
| `/agents/:id` | `AgentDetailView` | Full agent detail with skills + A2A card |

### Components

```
src/components/
├── layout/
│   └── AppHeader.vue         # Status bar: WS status, agent counts, nav
├── agents/
│   ├── AgentGrid.vue          # Scrollable list of AgentCards
│   ├── AgentCard.vue          # Individual card: health, skills, heartbeat
│   ├── HealthPulse.vue        # Animated dot (green/red CSS @keyframes)
│   └── SkillBadge.vue         # Skill tag badge
├── trace/
│   ├── TraceTimeline.vue      # Scrollable event list with auto-scroll
│   ├── TraceEntry.vue         # Single event: state badge, expand on click
│   ├── TraceFilters.vue       # Agent/state filter dropdowns
│   └── PayloadViewer.vue      # JSON renderer with clipboard copy
└── chat/
    ├── AgentChat.vue           # Chat panel: messages + input
    ├── ChatMessage.vue         # User/agent bubble
    └── AgentSelector.vue       # Agent picker dropdown
```

## WebSocket Protocol

The registry broadcasts JSON messages to all connected dashboards:

```typescript
// On connect — full state snapshot
{ type: "snapshot", agents: RegistryAgent[] }

// Agent lifecycle
{ type: "agent.registered", timestamp: string, data: RegistryAgent }
{ type: "agent.deregistered", timestamp: string, data: { agentId: string } }
{ type: "agent.heartbeat", timestamp: string, data: { agentId: string, timestamp: number } }
{ type: "agent.unhealthy", timestamp: string, data: { agentId: string } }
{ type: "agent.removed", timestamp: string, data: { agentId: string } }

// Task lifecycle (from agents via POST /events)
{ type: "task.update", timestamp: string, data: TaskUpdatePayload }
```

## Development

```bash
# In repo root — start the registry
pnpm run dev -- registry start

# In repo root — start an agent
pnpm run dev -- start .

# In dashboard/ — start the Vite dev server
pnpm run dev:dashboard
```

The Vite dev server proxies `/ws`, `/agents`, `/events` to `localhost:4999`.

## Production Build

```bash
# Build both backend and frontend
pnpm run build:all

# This compiles:
# 1. TypeScript → dist/
# 2. Vue app → dashboard/dist/
# 3. Copies dashboard/dist/ → dist/dashboard/
#
# The registry then serves dist/dashboard/ at GET /dashboard/*
```

After building, start the registry:
```bash
agent-bridge registry start
# Open: http://localhost:4999/dashboard
```

Or use the CLI:
```bash
agent-bridge dashboard
```

## Adding Features

### New view
1. Create `src/views/MyView.vue`
2. Add route to `src/router/index.ts`
3. Add nav link in `AppHeader.vue` if needed

### New Pinia store
1. Create `src/stores/mystore.ts` using `defineStore`
2. Import and use with `useMyStore()` in any component
3. Vue Devtools shows all stores for debugging

### New WS event type
1. Add to `WsMessage` union in `src/types/index.ts`
2. Handle in `useRegistryStore.handleMessage()` and/or `useTraceStore`
3. Backend: add event type to `RegistryEventType` in `src/registry/events.ts`

## Security Notes

- Registry WS is localhost-only — not exposed externally
- No authentication in development mode (by design)
- For production deployment, add auth middleware to the Express server
- Input sanitization: all agent data is displayed via Vue's template escaping
- `PayloadViewer` uses `JSON.stringify` only — no `innerHTML` or `v-html`
