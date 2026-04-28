# open-agent-bridge — Plan y Arquitectura del Proyecto

## Visión

Sistema para que agentes corriendo en diferentes terminales/proyectos locales puedan descubrirse, anunciar su estado, intercambiar contexto y responder solicitudes entre sí. Cada terminal actúa como un **agent endpoint** local que otros agentes pueden consultar o al que pueden delegarle subtareas.

El canal de mensajería permite comunicación bidireccional entre el adaptador MCP y sesiones cliente (Claude Code, Codex, dashboard, Gemini CLI).

## Decisión de stack

**Node.js / TypeScript** — WebSocket + HTTP async es su punto fuerte, el MCP SDK TypeScript es el más maduro, `npx` permite uso inmediato sin instalación global.

---

## Arquitectura actual

```
CLI / MCP Client / Dashboard
          |
          v
   RegistryServer (:4999)
   - HTTP /agents, /health, /events, /channel
   - WS   /ws  (snapshot, eventos registry + canal bidireccional)
   - SQLite  .open-agent-bridge/registry.sqlite
          |
          +---- AgentServer (:500x)
          |     - GET  /.well-known/agent.json   (A2A Agent Card)
          |     - POST /                          (A2A JSON-RPC)
          |     - POST /ag-ui                     (AG-UI SSE streaming)
          |     - GET  /health
          |     - WS   /ws
          |
          +---- CodexAppServerBridge  (clientVersion: "app-server-bridge")
          |     - entryType: "client", clientName: "codex"
          |     - Se registra en registry con prioridad de routing -1
          |     - Escucha mensajes de canal por WS del registry
          |     - Inyecta mensajes como turns en Codex app-server (turn/start JSON-RPC)
          |     - Responde vía reply del canal
          |
          +---- McpAgentBridge (stdio)
                - list_agents            — descubrir agentes y sesiones cliente
                - channel_inbox          — inspeccionar conversaciones pendientes
                - message_client_session — enviar mensaje a sesión cliente
                - reply                  — responder mensaje de canal entrante
                - resolveClientSession: prioriza bridge (-1) > claude-code > claude > codex
                - list_agents excluye dashboard y bridges (internos de routing)
```

---

## Componentes principales

### Registry (`src/registry/`)

Centro de descubrimiento y coordinación.

- Registro y desregistro de agentes y sesiones cliente (HTTP REST)
- Heartbeat y tracking de salud (unhealthy >90s, remove >300s)
- Snapshot inicial por WS + eventos incrementales (register, deregister, heartbeat, unhealthy)
- Almacenamiento y broadcast de mensajes de canal con ACKs
- Targeted delivery: si `toAgentId` está presente, entrega directa al WS de ese agente
- Fallback: EventBus hace broadcast a todos
- Persistencia SQLite en `.open-agent-bridge/registry.sqlite`

**Tablas SQLite:**
- `channel_messages` — payload completo de cada mensaje
- `channel_acks` — estados de entrega por mensaje
- `channel_suppressed_conversations` — tombstones de conversaciones borradas

### MCP Adapter (`src/mcp/adapter.ts`)

Expone la red de agentes como tools MCP consumibles desde Claude Code, Codex o Gemini CLI.

**Tools:**

| Tool | Descripción |
| --- | --- |
| `list_agents` | Lista agentes y sesiones cliente. Filtra internos (dashboard, bridge daemons) |
| `channel_inbox` | Conversaciones pendientes con `replyWith` context para responder |
| `message_client_session` | Envía mensaje de canal. `resolveClientSession` selecciona el mejor target |
| `reply` | Responde a un mensaje correlacionando conversación y replyTo |

**`resolveClientSession` — prioridad de routing:**

```
getPriority(entry):
  "app-server-bridge" → -1  (gana siempre)
  "claude-code"       →  0
  "claude"            →  1
  "gemini-cli"        →  2
  "gemini"            →  3
  "codex-cli"         →  4
  "codex"             →  5
  otros               →  6
```

Cuando hay un bridge daemon activo para el proyecto, los mensajes van al bridge y no al cliente TUI.

### Codex App Server Bridge (`src/client/codex-app-server-bridge.ts`)

Daemon intermediario entre el canal de mensajería y el app-server de Codex.

- Se registra como sesión cliente: `clientName: "codex"`, `clientVersion: "app-server-bridge"`
- Se identifica en WS del registry con su `agentId`
- Al recibir un mensaje de canal: lo inyecta en el proceso Codex vía JSON-RPC `turn/start`
- Codex procesa el turn y responde; el bridge reenvía la respuesta al canal

### Dashboard (`dashboard/`)

SPA Vue 3 + Pinia + Vue Router.

**Routing inteligente de mensajes:**

```typescript
// effectiveTargetId computed (ClientMessagePanel.vue)
const bridge = registryStore.agentList.find(
  (a) =>
    a.entryType === "client" &&
    a.clientInfo?.clientVersion === "app-server-bridge" &&
    a.projectPath === client.projectPath,
);
return bridge?.agentId ?? undefined;
// Si hay bridge → envía al bridge; si no → envía al cliente directamente
```

**`ChannelChatSession` (channel-chat-session.ts):**
- `sendMessage(text, toAgentIdOverride?)` — acepta override de target
- `sendReminder(toAgentIdOverride?)` — envía recordatorio de conversación pendiente
- `handleChannelMessage` — filtra por `conversationId` activo; acepta respuestas de cualquier agente dentro de la conversación

**`DashboardChannelRuntime` (channel-runtime.ts):**
- `onclose` ignora código `4001` (desconexión por supersesión) — evita reconexiones infinitas
- `acceptsDirectedMessage` filtra mensajes por `toAgentId` o `fromAgentId === selfClientId`
- Errores de listeners logueados con `console.error`

---

## Protocolo de mensajes

### Canal (bidireccional)

```typescript
ChannelMessagePayload {
  messageId: string;
  conversationId: string;
  fromAgentId: string;
  toAgentId?: string;
  content: string;
  kind: "chat" | "notification" | "reminder";
  expectsResponse?: boolean;
  requiresAck?: boolean;
  expiresAt?: number;
  meta?: Record<string, unknown>;
  createdAt: number;
}
```

### ACK de entrega

```typescript
ChannelAckPayload {
  ackId: string;
  messageId: string;
  conversationId: string;
  state: "queued" | "delivered" | "failed";
  detail?: string;
}
```

### A2A (agentes)

JSON-RPC 2.0 en HTTP y WebSocket. Método principal: `tasks/send`.

---

## Estado de implementación

### Implementado y funcionando

- Registry HTTP + WebSocket con snapshot y eventos incrementales
- Agentes A2A con skills, heartbeat, health tracking
- Skills builtin: `file-search`, `endpoint-find`, `code-query`, `prompt-execute`, `notify-claude`, `shell-execute`
- Skills dinámicos: `run-script`, `run-tests`, `docker-build`, `code-review`
- MCP adapter con tools: `list_agents`, `channel_inbox`, `message_client_session`, `reply`
- Canal bidireccional con `conversationId`, `messageId`, ACKs, estado de entrega
- Persistencia SQLite de mensajes y ACKs
- `CodexAppServerBridge` — integración canal ↔ Codex app-server
- Routing inteligente en `resolveClientSession` (bridge tiene prioridad -1)
- Dashboard: chat bidireccional, routing automático via bridge, historial de conversaciones
- `effectiveTargetId` en dashboard — detecta bridge activo por proyecto
- WS dashboard: `onclose` ignora código 4001 (no reconecta en supersesión)
- Filtros en `list_agents`: excluye `client-dashboard-ui` y `app-server-bridge`
- AG-UI SSE streaming endpoint en agentes
- Permission relay para Claude Code

### Limitaciones conocidas

- `tasks/sendSubscribe` no implementado end-to-end
- `StateGraph` existe pero su motor es parcial
- No hay autenticación para uso fuera de entorno local
- `handleChannelMessage` en el dashboard aún verifica `toAgentId !== DASHBOARD_AGENT_ID` — puede fallar si el servidor no preserva `toAgentId` en el broadcast WS

### Pendiente

- Simplificar `handleChannelMessage` para usar `fromAgentId === DASHBOARD_AGENT_ID` como early return en lugar de verificar `toAgentId` (más robusto para bridge-routed replies)
- Agregar logging diagnóstico en `channel-runtime.ts` `onmessage` para facilitar debugging de mensajes no recibidos
- Autenticación y seguridad para uso en red no local

---

## Flujo completo de ejemplo

```bash
# 1. Registry
pnpm run dev -- registry start
# → escuchando en http://localhost:4999

# 2. Agente en un proyecto
cd /projects/mi-proyecto
pnpm run dev -- start .
# → AgentServer en :5001, registrado como "mi-proyecto"

# 3. Bridge de Codex (si se usa Codex)
codex app-server:bridge start
# → registrado como clientName:"codex", clientVersion:"app-server-bridge"

# 4. Dashboard
pnpm run dev:dashboard
# → http://localhost:5173, se conecta al registry por WS

# 5. Claude Code usa MCP para listar y enviar
# → list_agents: ve "mi-proyecto" y clientes conectados
# → message_client_session("codex", "hola"): va al bridge → Codex responde

# 6. Dashboard muestra la conversación en tiempo real
```

---

## Decisiones de diseño destacadas

| Decisión | Razón |
| --- | --- |
| Bridge daemon con prioridad -1 en routing | Codex TUI y bridge comparten `clientName: "codex"`. Sin prioridad, el routing era no-determinístico |
| Excluir bridge y dashboard de `list_agents` | Son detalles de implementación, no targets para agentes. Evita confusión en los prompts de Claude/Codex |
| SQLite para persistencia de canal | Sin dependencias externas, suficiente para uso local, permite historial entre sesiones |
| `toAgentId` opcional en el protocolo | Permite broadcast a todos los participantes de una conversación sin conocer el ID de cada uno |
| `onclose` ignora código 4001 | El registry cierra con 4001 cuando una sesión es supersedida. Sin este check el dashboard reconectaba infinitamente |
