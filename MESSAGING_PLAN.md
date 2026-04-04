# Messaging Plan

## Objetivo

Construir un MVP de mensajeria conversacional que sea simple de implementar pero fuerte en arquitectura.

El foco es:

- mensajes entre agentes y Claude
- correlacion de conversaciones
- ACKs de entrega
- persistencia simple
- base clara para evolucionar despues

No entra en este alcance:

- LangGraph
- memoria semantica
- scheduling complejo
- fan-in/fan-out avanzado

## Resultado esperado

Al terminar este plan, el sistema debe poder:

- crear mensajes conversacionales con contrato estable
- asociar mensajes a una conversacion
- registrar ACKs y estado de entrega
- responder un mensaje usando `replyTo`
- consultar el historial de una conversacion
- dejar la base lista para reanudar tareas mas adelante

## Estructura propuesta

### 1. Contrato de mensaje

Definir tipos estables para la mensajeria.

Campos base:

- `conversationId`
- `messageId`
- `replyTo`
- `taskId`
- `fromAgentId`
- `toAgentId`
- `kind`
- `content`
- `meta`
- `requiresAck`
- `expectsResponse`
- `createdAt`

Estados base de entrega:

- `queued`
- `delivered_to_bridge`
- `displayed_to_client`
- `answered`
- `failed`

### 2. Store de mensajeria

El registry deja de ser solo broadcaster y pasa a ser la fuente de verdad del canal.

Debe guardar:

- conversaciones
- mensajes
- ACKs
- mensajes pendientes

Persistencia inicial recomendada:

- `SQLite`

Si se necesita una primera iteracion aun mas corta:

- store en memoria con interfaz preparada para persistencia

### 3. Router de mensajes

Responsable de:

- aceptar mensajes
- persistirlos
- emitir eventos
- registrar ACKs
- correlacionar replies
- exponer historial de conversacion

### 4. Adaptadores de transporte

Responsables de mover mensajes, no de definir su estado.

Transportes actuales:

- registry HTTP
- registry WebSocket
- MCP bridge
- agent relay

## Fases

### Fase 1. Tipos y eventos

Objetivo:

- dejar estable el contrato de mensajes

Entregables:

- tipos `ChannelMessage`
- tipos `ChannelAck`
- tipos `ChannelConversationSnapshot`
- eventos `channel.message`
- eventos `channel.ack`

Archivos:

- `src/types/messages.ts`
- `src/registry/events.ts`

Estado:

- Completada

Resumen:

- Se agregaron tipos base del canal conversacional y nuevos eventos del registry.
- Quedaron listos `ChannelMessage`, `ChannelAck` y `ChannelConversationSnapshot`.

### Fase 2. Store y endpoints del registry

Objetivo:

- mover la mensajeria a un flujo centralizado y consultable

Entregables:

- store de conversaciones
- endpoint `POST /channel/messages`
- endpoint `POST /channel/acks`
- endpoint `GET /channel/conversations/:id`
- broadcast de `channel.message`
- broadcast de `channel.ack`

Archivos:

- `src/registry/server.ts`
- `src/registry/store.ts` o nuevo `src/registry/channel-store.ts`

Estado:

- Completada

Resumen:

- Se creo `ChannelStore` en memoria para conversaciones y ACKs.
- El registry ahora expone:
  - `POST /channel/messages`
  - `POST /channel/acks`
  - `GET /channel/conversations/:id`
- El registry ya emite `channel.message` y `channel.ack`.

### Fase 3. Integrar `notify-claude`

Objetivo:

- dejar de enviar notificaciones sueltas y pasar a mensajes conversacionales

Entregables:

- `notify-claude` envia `ChannelMessage`
- soporte para `conversationId`, `messageId`, `taskId`
- opcion `requiresAck`
- opcion `expectsResponse`

Archivos:

- `src/skills/builtins/notify-claude.ts`

Estado:

- Completada

Resumen:

- `notify-claude` ahora envia envelopes conversacionales.
- La skill ya soporta `conversationId`, `replyTo`, `requiresAck` y `expectsResponse`.
- La respuesta incluye `conversationId` y `messageId`.

### Fase 4. Integrar `McpAgentBridge`

Objetivo:

- convertir el bridge en adaptador serio de mensajeria

Entregables:

- ACK automatico al reenviar a Claude
- correlacion de respuestas
- `reply` con `conversationId` y `replyTo`
- store en memoria para mensajes pendientes si hace falta

Archivos:

- `src/mcp/adapter.ts`

Estado:

- Completada

Resumen:

- El bridge escucha `channel.message`.
- Registra ACKs automaticos:
  - `delivered_to_bridge`
  - `displayed_to_client`
- `reply` ahora crea mensajes conversacionales correlacionados en lugar de responder solo por tarea.
- Se mantiene compatibilidad basica con `claude.notify`.

### Fase 5. Enlace con tareas

Objetivo:

- preparar la union entre conversacion y ejecucion

Entregables:

- asociar `taskId` con mensajes
- base para `input-required`
- base para reanudacion posterior

Archivos:

- `src/agent/handlers.ts`
- `src/types/a2a.ts`

Estado:

- En progreso

Resumen:

- Se agrego recepcion de `channel.message` en el agente por WebSocket del registry.
- `notify-claude` con `expectsResponse=true` ahora deja la tarea en `input-required`.
- Cuando llega un `reply` correlacionado por `conversationId` o `taskId`, la tarea se reanuda y pasa a `completed`.
- Se agregaron timeouts de espera en tareas pendientes.
- El canal ahora soporta expiracion por mensaje, listado de conversaciones pendientes y retry basico desde el registry.
- Falta endurecer esta parte con politicas de reintento automatico y persistencia duradera.

## Archivos por responsabilidad

### `src/types/messages.ts`

- contrato del canal
- estados de entrega
- snapshot de conversacion

### `src/registry/events.ts`

- eventos del bus interno del registry

### `src/registry/server.ts`

- endpoints HTTP del canal
- publicacion de eventos

### `src/registry/store.ts` o `src/registry/channel-store.ts`

- persistencia y consulta de conversaciones

### `src/skills/builtins/notify-claude.ts`

- crear mensaje conversacional saliente

### `src/mcp/adapter.ts`

- adaptar mensajes del canal a Claude
- registrar ACKs
- resolver replies

### `src/agent/handlers.ts`

- enlazar mensajes con ciclo de vida de tareas

## Reglas de diseño

- el contrato de mensaje vive fuera del transporte
- el registry es fuente de verdad del canal
- los ACKs son explicitos
- `reply` siempre referencia un mensaje previo
- no depender solo de WebSocket para el estado
- no mezclar mensaje conversacional con respuesta RPC cruda

## Control de avance

Usar esta seccion para actualizar rapido el estado sin reescribir todo el documento.

### Estado general

- Fase 1: Completada
- Fase 2: Completada
- Fase 3: Completada
- Fase 4: Completada
- Fase 5: En progreso

### Ultimo resumen

- Quedo implementado el MVP base del canal conversacional.
- El registry ya persiste conversaciones y ACKs en memoria.
- `notify-claude` ya emite mensajes correlacionados.
- El `McpAgentBridge` ya registra ACKs y `reply` conversacional.
- Las tareas del agente ya pueden quedar en `input-required` y reanudarse por reply del canal.
- Ya existen timeout, expiracion y retry basico para conversaciones pendientes.
- El backend compila correctamente con `pnpm run build`.

### Proximo paso

- Si hace falta, migrar el `ChannelStore` de memoria a SQLite y agregar retry automatico por scheduler.
