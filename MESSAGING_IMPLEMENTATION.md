# Messaging Implementation

## Objetivo

Documentar los cambios realizados para llevar `agent-bridge` desde un flujo de notificacion simple a un MVP de mensajeria conversacional orientado a clientes MCP, con Codex como capa objetivo de produccion.

## Estado actual

El sistema ya soporta:

- mensajes conversacionales con `conversationId` y `messageId`
- ACKs del canal
- `reply` correlacionado
- tareas que pasan a `input-required`
- reanudacion de tareas por respuesta de channel
- separacion entre agentes A2A y sesiones cliente
- tool generica para sesiones cliente: `message_client_session`
- alias de compatibilidad: `message_claude_client`
- observabilidad basica de channels en el dashboard
- persistencia local del canal en SQLite
- vista dedicada `/channels`
- runtime conversacional compartido para clientes Node-side
- seguimiento de pendientes por mensaje
- expiracion local derivada del mensaje pendiente
- tombstones locales para conversaciones borradas
- perfiles cliente `push-first` e `inbox-first`
- configuracion de automatizacion para clientes no nativos via `.agent-bridge.mcp.yml`
- proxy dedicado para Codex dentro del bridge MCP
- accion manual `remind` desde el chat del dashboard

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

- almacenamiento persistente de mensajes en SQLite
- almacenamiento persistente de ACKs en SQLite
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

### 5. Persistencia local del canal

Archivo:

- `src/registry/channel-store.ts`

Se agrego:

- base SQLite local en `.agent-bridge/registry.sqlite`
- tablas para mensajes y ACKs
- lectura ordenada por conversacion

Impacto:

- los mensajes del canal sobreviven reinicios del proceso

### 6. Estabilidad de registro

Archivo:

- `src/registry/store.ts`

Se agrego reemplazo de entradas duplicadas para:

- clientes Claude del mismo proyecto y mismo cliente
- agentes del mismo proyecto

Impacto:

- el registry se estabiliza mejor cuando Claude se reconecta

### 7. Resolucion de sesiones cliente

Archivo:

- `src/client/registry-client.ts`

Se agrego:

- `findClientSession()`

Impacto:

- `notify-claude`, `message_client_session` y el alias `message_claude_client` pueden resolver destino por `clientId` o `project`

### 8. `notify-claude`

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

### 9. Enlace con tareas

Archivo:

- `src/agent/handlers.ts`

Se agrego:

- mapeo `conversationId -> taskId`
- estado `input-required`
- timeout de espera
- reanudacion de tarea por `reply`

Impacto:

- una tarea puede pausar y continuar por channel

### 10. Recepcion de channel en agente

Archivo:

- `src/agent/server.ts`

Se agrego:

- recepcion de `channel.message`
- intento de reanudar tareas correlacionadas

Impacto:

- el agente ya puede consumir respuestas del canal

### 11. Bridge MCP

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
- quedó una capa separada para sesiones cliente pasivas
- la superficie MCP ahora puede evolucionar hacia Codex sin depender del naming Claude

### 12. Runtime conversacional compartido

Archivos:

- `src/client/channel-transport.ts`
- `src/client/channel-client-runtime.ts`
- `src/client/conversation-session-store.ts`
- `src/client/conversation-service.ts`
- `src/client/client-profile-resolver.ts`

Se agrego:

- transporte HTTP + WS compartido
- runtime de cliente para registro, heartbeat, envio y ACK
- store conversacional local
- servicio conversacional para `startConversation`, `replyAndAcknowledge`, snapshots y expiracion local
- perfiles explicitos para `Claude`, `Codex` y `Gemini`

Impacto:

- la capa node-side ya tiene una base comun para Codex, Claude, Gemini y futuros clientes

### 13. Capa Codex-first en el bridge MCP

Archivos:

- `src/client/profiles/codex-client-profile.ts`
- `src/client/profiles/gemini-client-profile.ts`
- `src/client/profiles/claude-client-profile.ts`
- `src/client/client-profile-resolver.ts`
- `src/mcp/adapter.ts`
- `src/mcp/proxies/codex-proxy.ts`
- `src/mcp/proxies/gemini-proxy.ts`
- `src/mcp/config.ts`
- `.agent-bridge.mcp.yml`
- `src/cli/commands/mcp.ts`

Se cambio:

- `CodexClientProfile` usa `notifications/message` como superficie generica
- `GeminiClientProfile` sigue el mismo contrato generico
- `ClaudeClientProfile` conserva `notifications/claude/channel`
- el resolver ya no cae por defecto a Claude; ahora usa Codex como comportamiento generico seguro
- la tool principal paso a ser `message_client_session`
- `message_claude_client` queda como alias de compatibilidad
- Codex y Gemini se tratan como clientes `inbox-first`
- Claude se mantiene como cliente `push-first`
- los clientes `inbox-first` reciben un recordatorio liviano por notificacion y usan `channel_inbox` para leer el mensaje completo
- mientras el mensaje siga pendiente, el bridge reenvia recordatorios periodicos a clientes `inbox-first`
- el bridge tambien hace polling local del inbox conversacional y solo vuelve a anunciar mensajes pendientes no vistos
- `message_client_session` ahora espera brevemente un ACK y retorna `deliveryState`
- la automatizacion de clientes no nativos ahora se puede configurar desde `.agent-bridge.mcp.yml`
- Codex ahora usa un proxy dedicado dentro del bridge MCP para transformar mensajes entrantes y pendientes en notificaciones con contexto del hilo
- Gemini ahora usa un proxy dedicado dentro del bridge MCP para el mismo flujo `inbox-first`, incluyendo mensajes nuevos, pendientes y conversaciones activas
- la CLI `agent-bridge mcp start` ahora acepta `--config` para cargar una config YAML explicita

Impacto:

- el MVP ya no refleja una arquitectura Claude-only
- Codex queda como capa objetivo de produccion sin romper soporte actual para Claude
- Gemini ya entra sobre el mismo seam que Codex sin rehacer la mensajeria
- ya no asumimos que `fit-backend -> Codex` aparezca como push automatico; en Codex el flujo correcto es `channel_inbox` + `reply`
- al enviar mensajes desde MCP ya se puede ver de inmediato si el bridge alcanzo al menos `delivered_to_bridge` o `displayed_to_client`

### 14. Pendientes por mensaje y ACK correcto

Archivos:

- `src/client/conversation-session-store.ts`
- `src/client/conversation-service.ts`

Se cambio:

- el estado pendiente ya no es un unico booleano global por conversacion
- cada conversacion mantiene `pendingMessageIds`
- `answered` y `failed` se aplican al mensaje pendiente original

Impacto:

- una respuesta ya no cierra por error toda la conversacion
- varias solicitudes pendientes dentro del mismo `conversationId` ya no se pisan

### 15. Tombstones locales

Archivos:

- `src/client/conversation-session-store.ts`
- `src/client/channel-client-runtime.ts`

Se agrego:

- tombstones para conversaciones borradas localmente
- ignorar `channel.message` y `channel.ack` entrantes de conversaciones suprimidas
- reactivacion solo cuando el cliente vuelve a enviar explicitamente sobre esa conversacion

Impacto:

- una conversacion borrada ya no resucita sola con historial roto
- el runtime puede seguir una supresion emitida por el registry

### 16. Alineacion del registry con el modelo conversacional

Archivos:

- `src/registry/channel-store.ts`
- `src/types/messages.ts`
- `dashboard/src/types/index.ts`

Se cambio:

- `listConversations()` ya no usa solo `lastMessage`
- `pendingReply` y `expired` se calculan sobre todos los mensajes pendientes
- se agregan `pendingCount`, `pendingMessageIds` y `status` al resumen de conversacion

Impacto:

- el registry y el runtime local quedaron mucho mas alineados
- se reducen contradicciones entre `/channel/conversations` y `channel_inbox`

### 17. Una sola verdad para supresion de conversaciones

Archivos:

- `src/registry/channel-store.ts`
- `src/registry/server.ts`
- `src/registry/events.ts`
- `src/client/registry-client.ts`
- `src/client/channel-client-runtime.ts`
- `src/mcp/adapter.ts`

Se agrego:

- persistencia SQLite para conversaciones suprimidas
- endpoint `POST /channel/conversations/:id/suppress`
- endpoint `DELETE /channel/conversations/:id/suppress`
- eventos WS:
  - `channel.conversation.suppressed`
  - `channel.conversation.revived`
- `delete_channel_conversation` ahora suprime en registry y luego sincroniza local

Impacto:

- la supresion ya no es una verdad solo local
- dashboard, registry y clientes pueden converger sobre el mismo estado
- la conversacion solo se reactiva cuando el registry la revive o cuando un nuevo envio explicito la reabre

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

### 7. Vista de conversaciones

Archivos:

- `dashboard/src/views/ChannelsView.vue`
- `dashboard/src/router/index.ts`
- `dashboard/src/lib/registry-client.ts`
- `dashboard/src/components/layout/AppHeader.vue`

Cambios:

- ruta nueva `/channels`
- listado de conversaciones
- filtro `pending only`
- detalle de mensajes y ACKs por `conversationId`
- acciones para `suppress` y `revive`
- chips por `status`
- resumen de `pendingCount`
- filtro visual para conversaciones expiradas
- refresco en vivo por eventos WS del registry:
  - `channel.message`
  - `channel.ack`
  - `channel.conversation.suppressed`
  - `channel.conversation.revived`
- refresco incremental por conversacion afectada, sin recargar toda la lista en cada evento

### 8. Chat operativo para sesiones cliente

Archivos:

- `dashboard/src/lib/channel-chat-session.ts`
- `dashboard/src/stores/chat.ts`
- `dashboard/src/components/chat/AgentChat.vue`
- `dashboard/src/components/chat/AgentSelector.vue`
- `dashboard/src/components/chat/ChatMessage.vue`

Cambios:

- el chat del dashboard se enfoco en sesiones cliente del canal y no en `ag-ui`
- se mantiene `conversationId` activo por cliente seleccionado
- el selector muestra sesiones cliente pasivas como destino principal
- se agrego la accion `remind` para volver a empujar seguimiento dentro del mismo hilo

Impacto:

- el dashboard ya sirve como operador manual de conversaciones con clientes `inbox-first`
- el recordatorio manual complementa el polling y los reminders del bridge cuando el cliente no responde solo

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

### 5. YAML configurable pero no autonomo

Problema:

- el archivo `.agent-bridge.mcp.yml` si cambia el comportamiento interno del bridge
- pero no puede obligar a Codex a ejecutar tools ni responder automaticamente

Decision:

- mantener el YAML como configuracion de polling y reminders
- dejar claro que la automatizacion real para clientes no nativos depende de un proxy o companion mas activo
- introducir `CodexProxy` para enriquecer la notificacion y acercar la experiencia a una activacion usable

## Validacion realizada

Se validó repetidamente con:

- `pnpm run build`
- `cd dashboard && pnpm run build`

## Limites actuales

Todavia falta:

- retry automatico programado
- evolucionar el proxy de Codex si se quiere comportamiento mas autonomo que `inbox-first`
- mejor experiencia para seleccionar clientes destino desde dashboard y tooling
- acciones de reintento/cierre mas completas desde la vista `/channels`

## Siguiente paso recomendado

Prioridad alta:

- scheduler de retry automatico y expiracion visible por UI
- decidir si la supresion debe evolucionar a archivado con metadatos
- si se quiere mas automatizacion para Codex, endurecer el proxy en vez de seguir empujando solo YAML

Prioridad media:

- selector de clientes destino en dashboard o tooling

Prioridad baja:

- acciones de retry y filtros avanzados por conversacion
