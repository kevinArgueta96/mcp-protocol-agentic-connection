# agent-bridge

Hub local de comunicación entre agentes para terminal y proyectos en desarrollo. `agent-bridge` conecta agentes vía HTTP, WebSocket, JSON-RPC 2.0 y expone esa red como herramientas MCP para clientes como Claude Code, Codex o Gemini CLI.

El repositorio tiene dos superficies principales:

- Runtime TypeScript con CLI, registry, agentes A2A, clientes y adaptador MCP.
- Dashboard Vue 3 para visualizar agentes y gestionar conversaciones de canal en tiempo real.

## Estado actual

El proyecto compila y cubre el flujo local completo incluyendo mensajería conversacional bidireccional:

- `pnpm run build` en la raíz compila el backend TypeScript.
- `pnpm run build` dentro de `dashboard/` compila el frontend Vue.
- El registry expone HTTP y WebSocket en `localhost:4999`.
- Los agentes se registran en el registry, publican heartbeat y emiten eventos de tareas.
- El dashboard consume el WebSocket del registry y permite chat bidireccional con agentes.
- El adaptador MCP arranca en `stdio` y expone 4 tools: `list_agents`, `channel_inbox`, `message_client_session`, `reply`.
- Canal bidireccional con mensajería conversacional — `conversationId`, `messageId`, ACKs, estado de entrega.
- Persistencia de mensajes de canal en SQLite (`.agent-bridge/registry.sqlite`).
- `CodexAppServerBridge` — daemon que recibe mensajes de canal y los inyecta en el app-server de Codex vía JSON-RPC `turn/start`.
- Dashboard enruta mensajes al bridge correcto automáticamente cuando Codex está activo.

Limitaciones actuales:

- El transporte es local por defecto y hace bind en `localhost`.
- `tasks/sendSubscribe` y el streaming A2A no están implementados end-to-end.
- No hay autenticación ni endurecimiento de seguridad para uso fuera de entorno local.

## Requisitos

- Node.js `>=22`
- `pnpm`

## Instalación

```bash
pnpm install
cd dashboard && pnpm install
```

## Estructura rápida

```text
.
├── src/
│   ├── agent/
│   │   ├── server.ts                   # AgentServer: HTTP + WS + A2A + AG-UI
│   │   ├── handlers.ts                 # TaskStore, RequestRouter, skill inference
│   │   ├── card.ts                     # Generador de AgentCard A2A
│   │   ├── project-detector.ts         # Detección de tipo de proyecto
│   │   └── ag-ui-events.ts             # Helpers para AG-UI SSE events
│   ├── cli/                            # Comandos agent-bridge
│   ├── client/
│   │   ├── codex-app-server-bridge.ts  # Bridge daemon para Codex
│   │   └── ...
│   ├── mcp/
│   │   └── adapter.ts                  # McpAgentBridge: 4 MCP tools + resolución de sesión
│   ├── registry/
│   │   ├── server.ts                   # RegistryServer HTTP + WebSocket
│   │   ├── channel-store.ts            # Persistencia SQLite de mensajes y ACKs
│   │   └── ...
│   ├── skills/                         # Skills framework y builtins
│   └── types/                          # Tipos A2A, JSON-RPC y mensajes de canal
├── dashboard/                          # SPA Vue 3 + Pinia + Vue Router
├── PLAN.md                             # Arquitectura y estado del proyecto
└── docs/                               # Documentación técnica detallada
```

## Quickstart local

### 1. Levantar el registry

```bash
pnpm run dev -- registry start
```

Registry por defecto:

- HTTP: `http://localhost:4999`
- WebSocket: `ws://localhost:4999/ws`
- Dashboard servido por el registry si existe `dashboard/dist`: `http://localhost:4999/dashboard`

### 2. Levantar un agente en un proyecto

```bash
pnpm run dev -- start .
```

Al arrancar, el agente:

- detecta el tipo de proyecto por archivos conocidos
- construye su Agent Card
- expone HTTP y WebSocket
- se registra en el registry
- manda heartbeat cada 30 segundos

### 3. Levantar el bridge de Codex (para proyectos Codex)

El bridge daemon conecta el canal de mensajería con el app-server de Codex. Se registra automáticamente con `clientName: "codex"` y `clientVersion: "app-server-bridge"`. Recibe mensajes de canal y los inyecta como turns en Codex vía JSON-RPC `turn/start`.

```bash
codex app-server:bridge start
```

### 4. Listar agentes

```bash
pnpm run dev -- list
```

### 5. Abrir el dashboard

En desarrollo:

```bash
pnpm run dev:dashboard
```

Si ya compilaste el dashboard y el registry está arriba:

```text
http://localhost:4999/dashboard
```

El dashboard detecta automáticamente si el proyecto seleccionado tiene un bridge daemon activo y enruta los mensajes a través de él.

### 6. Usar como servidor MCP

Arranque rápido en `stdio`:

```bash
pnpm run dev -- mcp start
```

Generar configuración `.mcp.json`:

```bash
pnpm run dev -- mcp config
```

## Scripts

### Raíz

| Script | Descripción |
| --- | --- |
| `pnpm run build` | Compila TypeScript a `dist/` |
| `pnpm run dev` | Ejecuta la CLI desde `src/cli/index.ts` con `tsx` |
| `pnpm run start` | Ejecuta la CLI compilada desde `dist/cli/index.js` |
| `pnpm run clean` | Borra `dist/` |
| `pnpm run build:dashboard` | Compila solo el dashboard |
| `pnpm run build:all` | Compila backend, dashboard y copia `dashboard/dist` a `dist/dashboard` |
| `pnpm run dev:dashboard` | Levanta Vite para el dashboard |

### Dashboard

Dentro de `dashboard/`:

| Script | Descripción |
| --- | --- |
| `pnpm run dev` | Levanta Vite en `localhost:5173` |
| `pnpm run build` | Ejecuta `vue-tsc --noEmit` y build de Vite |
| `pnpm run preview` | Sirve el build del dashboard |

## Comandos CLI

| Comando | Descripción |
| --- | --- |
| `start [path]` | Arranca un agente para un directorio |
| `registry start` | Arranca el registry |
| `registry status` | Consulta salud del registry |
| `list` | Lista agentes activos |
| `health [agent-id]` | Verifica alcanzabilidad de agentes |
| `ask <agent> <message>` | Envía una tarea a un agente |
| `find <query>` | Busca agentes por skill o proyecto |
| `delegate <skill-id> <message>` | Envía una tarea al mejor agente saludable con esa skill |
| `broadcast <message>` | Envía un mensaje a todos los agentes saludables |
| `mcp start` | Arranca el adaptador MCP en `stdio` |
| `mcp config` | Imprime o escribe configuración MCP |
| `dashboard` | Imprime o abre la URL del dashboard |

## Canal de mensajería

El canal es el sistema de comunicación bidireccional principal entre el adaptador MCP y sesiones cliente (Claude Code, Codex, dashboard).

### Tools MCP disponibles

| Tool | Descripción |
| --- | --- |
| `list_agents` | Lista agentes y sesiones cliente conectados. Excluye dashboard y bridges (detalles internos de routing) |
| `channel_inbox` | Consulta conversaciones de canal pendientes con contexto para responder |
| `message_client_session` | Envía un mensaje de canal a una sesión cliente. Resuelve automáticamente el mejor target (bridge tiene prioridad) |
| `reply` | Responde a un mensaje de canal entrante correlacionando la conversación |

### Flujo de mensaje a Codex

```
Claude Code → message_client_session("codex", "mensaje")
                    ↓
            resolveClientSession()  ← prioriza bridge daemon (prioridad -1) sobre TUI MCP client
                    ↓
      CodexAppServerBridge recibe por WS
                    ↓
      Inyecta turn/start en el app-server de Codex
                    ↓
      Codex responde → reply vía canal → dashboard lo muestra
```

### Flujo desde el dashboard

El panel de chat del dashboard detecta automáticamente si el proyecto seleccionado tiene un bridge activo:

```
Dashboard → effectiveTargetId computed:
  - busca agente con clientVersion === "app-server-bridge" en el mismo projectPath
  - si lo encuentra: envía al bridge.agentId
  - si no: envía directamente al agentId del cliente
```

### Persistencia

Todos los mensajes y ACKs de canal se persisten en SQLite:

```
.agent-bridge/registry.sqlite
  ├── channel_messages                 — payload completo de cada mensaje
  ├── channel_acks                     — estados de entrega (queued, delivered, failed)
  └── channel_suppressed_conversations — conversaciones borradas (tombstones)
```

### Routing de entrega

El registry hace **targeted delivery**: si el mensaje tiene `toAgentId`, lo entrega directamente al WS de ese agente. El EventBus hace broadcast a todos los demás como fallback.

## Skills incluidas

### Skills builtin (siempre disponibles)

| Skill | Propósito |
| --- | --- |
| `file-search` | Buscar archivos por glob pattern |
| `endpoint-find` | Detectar endpoints en backends o llamadas API en frontends |
| `code-query` | Buscar texto o regex en el código fuente |
| `prompt-execute` | Renderizar un prompt template con variables |
| `notify-claude` | Enviar notificación al terminal de Claude Code vía canal |
| `shell-execute` | Ejecutar un comando shell en el directorio del proyecto |

### Skills dinámicos (detectados automáticamente)

| Skill | Condición de activación |
| --- | --- |
| `run-script` | `package.json` existe |
| `run-tests` | jest/vitest/pytest/pom.xml detectado |
| `docker-build` | `Dockerfile` existe |
| `code-review` | directorio `src/` existe |

## Arquitectura

```text
CLI / MCP Client / Dashboard
          |
          v
   RegistryServer (:4999)
   - HTTP /agents, /health, /events, /channel
   - WS   /ws  (snapshot, eventos, canal bidireccional)
   - SQLite  .agent-bridge/registry.sqlite
          |
          +---- AgentServer (:500x)
          |     - A2A JSON-RPC, skills, AG-UI SSE
          |
          +---- CodexAppServerBridge  (clientVersion: "app-server-bridge")
          |     - Se registra como sesión cliente (entryType: "client")
          |     - Recibe mensajes de canal por WS
          |     - Inyecta en Codex app-server vía turn/start JSON-RPC
          |
          +---- McpAgentBridge (stdio)
                - list_agents, channel_inbox, message_client_session, reply
                - resolveClientSession: bridge daemon gana por prioridad -1
                - Excluye dashboard y bridges de list_agents
```

## Notas para mantenedores

- `PLAN.md` describe la arquitectura y estado actual del proyecto.
- El bridge daemon (`clientVersion: "app-server-bridge"`) **no aparece** en `list_agents` — es un detalle de routing interno.
- El dashboard UI (`client-dashboard-ui`) tampoco aparece en `list_agents` por la misma razón.
- El `onclose` del WS del dashboard ignora código `4001` (desconexión por supersesión) para evitar reconexiones infinitas.
- Si se agregan nuevos MCP tools, actualizar la tabla de tools en este README y en `PLAN.md`.
