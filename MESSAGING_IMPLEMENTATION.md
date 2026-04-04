# Messaging Implementation

## Objetivo

Documentar los cambios realizados para llevar `agent-bridge` desde un flujo de notificacion simple a un MVP de mensajeria conversacional orientado a Claude Channels.

## Estado actual

El sistema ya soporta:

- mensajes conversacionales con `conversationId` y `messageId`
- ACKs del canal
- `reply` correlacionado
- tareas que pasan a `input-required`
- reanudacion de tareas por respuesta de channel
- separacion entre agentes A2A y clientes Claude
- tool dedicada para clientes Claude: `message_claude_client`
- observabilidad basica de channels en el dashboard

## Cambios backend

### 1. Contrato de mensajeria

Archivo:

- `src/types/messages.ts`

Se agregaron:

- `ChannelMessage`
- `ChannelAck`
- `ChannelConversationSnapshot`
- estados de entrega del canal
- campos de expiracion e intentos

Impacto:

- ya no dependemos de payloads ad hoc
- los mensajes y replies se correlacionan formalmente

### 2. Eventos del registry

Archivo:

- `src/registry/events.ts`

Se agregaron:

- `channel.message`
- `channel.ack`

Impacto:

- el dashboard y cualquier cliente WS pueden observar el canal

### 3. Store de conversaciones

Archivo:

- `src/registry/channel-store.ts`

Se implemento:

- almacenamiento en memoria de mensajes
- almacenamiento en memoria de ACKs
- consulta por conversacion
- listado de conversaciones
- retry basico

Impacto:

- el registry paso de broadcaster a fuente de verdad del canal

### 4. Endpoints del canal

Archivo:

- `src/registry/server.ts`

Se agregaron:

- `POST /channel/messages`
- `POST /channel/acks`
- `GET /channel/conversations/:id`
- `GET /channel/conversations`
- `POST /channel/messages/:conversationId/:messageId/retry`

Tambien se adapto:

- `POST /notify-claude`

Impacto:

- el canal ya tiene API propia
- `notify-claude` ya no es solo una notificacion suelta

### 5. Estabilidad de registro

Archivo:

- `src/registry/store.ts`

Se agrego reemplazo de entradas duplicadas para:

- clientes Claude del mismo proyecto y mismo cliente
- agentes del mismo proyecto

Impacto:

- el registry se estabiliza mejor cuando Claude se reconecta

### 6. Resolucion de clientes Claude

Archivo:

- `src/client/registry-client.ts`

Se agrego:

- `findClaudeClient()`

Impacto:

- `notify-claude` y `message_claude_client` pueden resolver destino por `clientId` o `project`

### 7. `notify-claude`

Archivo:

- `src/skills/builtins/notify-claude.ts`

Se cambio para soportar:

- `targetClientId`
- `targetProject`
- `conversationId`
- `replyTo`
- `expectsResponse`
- `responseTimeoutMs`

Impacto:

- ahora envia a una sesion Claude concreta
- ya no usa un destino global tipo `"claude"` como base del MVP

### 8. Enlace con tareas

Archivo:

- `src/agent/handlers.ts`

Se agrego:

- mapeo `conversationId -> taskId`
- estado `input-required`
- timeout de espera
- reanudacion de tarea por `reply`

Impacto:

- una tarea puede pausar y continuar por channel

### 9. Recepcion de channel en agente

Archivo:

- `src/agent/server.ts`

Se agrego:

- recepcion de `channel.message`
- intento de reanudar tareas correlacionadas

Impacto:

- el agente ya puede consumir respuestas del canal

### 10. Bridge MCP

Archivo:

- `src/mcp/adapter.ts`

Cambios principales:

- escucha `channel.message`
- registra ACKs:
  - `delivered_to_bridge`
  - `displayed_to_client`
- `reply` ahora crea mensajes conversacionales
- filtro de `task.request` por `toAgentId === clientAgentId`
- eliminacion del relay de permisos del flujo principal
- nueva tool `message_claude_client`
- `ask_agent` rechaza clientes pasivos
- instrucciones MCP separan agentes y clientes

Impacto:

- se corrigieron loops y mensajes `unknown`
- quedó una capa separada para sessions Claude

## Cambios frontend

### 1. Tipos del dashboard

Archivo:

- `dashboard/src/types/index.ts`

Se agregaron:

- `channel.message`
- `channel.ack`
- campos conversacionales en `TraceEvent`

### 2. Registry store

Archivo:

- `dashboard/src/stores/registry.ts`

Se agregaron:

- `clientList`
- `runnableAgentList`
- `clientCount`

### 3. Trace store

Archivo:

- `dashboard/src/stores/trace.ts`

Ahora consume:

- `task.update`
- `channel.message`
- `channel.ack`

### 4. Header

Archivo:

- `dashboard/src/components/layout/AppHeader.vue`

Ahora muestra:

- cantidad de agentes
- cantidad de clientes

### 5. Grid de agentes

Archivo:

- `dashboard/src/components/agents/AgentGrid.vue`

Cambios:

- ya no oculta entradas `unhealthy`
- separa clientes Claude y agentes con skills

### 6. Trace UI

Archivos:

- `dashboard/src/components/trace/TraceTimeline.vue`
- `dashboard/src/components/trace/TraceEntry.vue`
- `dashboard/src/components/trace/TraceFilters.vue`

Cambios:

- timeline de tasks + channels
- badges para `channel in`, `channel out`, `ack`
- filtro por `kind`
- soporte visual para `input-required`

## Problemas encontrados y decisiones

### 1. Permission relay mezclado con chat

Problema:

- los `permission_request` terminaban como mensajes normales de channel
- aparecian mensajes tipo `yes <id>` con `agentId: "unknown"`

Decision:

- sacar el relay de permisos del flujo principal del MVP

### 2. Broadcast a todas las sesiones Claude

Problema:

- varias sesiones Claude veian solicitudes que no eran para ellas

Decision:

- filtrar por `clientAgentId`

### 3. Mezcla entre clientes y agentes

Problema:

- Claude intentaba usar `ask_agent` contra `client-claude-code-*`

Decision:

- separar herramientas:
  - `ask_agent`
  - `message_claude_client`

### 4. Dashboard escondia entradas

Problema:

- al pasar a `unhealthy`, algunas entradas desaparecian de la UI

Decision:

- dejar visibles las entradas y mostrar el estado

## Validacion realizada

Se validó repetidamente con:

- `pnpm run build`
- `cd dashboard && pnpm run build`

## Limites actuales

Todavia falta:

- persistencia durable real del canal
- retry automatico programado
- vista de conversaciones agrupadas por `conversationId`
- mejor experiencia para seleccionar clientes Claude destino

## Siguiente paso recomendado

Prioridad alta:

- pasar `ChannelStore` a `SQLite`

Prioridad media:

- crear un panel de conversaciones en el dashboard

Prioridad baja:

- scheduler de retry automatico y expiracion visible por UI
