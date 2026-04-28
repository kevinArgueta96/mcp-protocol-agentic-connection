# A2A y API

## Resumen

El sistema usa JSON-RPC 2.0 sobre HTTP y WebSocket. El modelo base de mensajes y tareas vive en:

- [`src/types/a2a.ts`](/Users/kevin/Documents/dev_projects/open-agent-bridge/src/types/a2a.ts)
- [`src/types/jsonrpc.ts`](/Users/kevin/Documents/dev_projects/open-agent-bridge/src/types/jsonrpc.ts)
- [`src/types/messages.ts`](/Users/kevin/Documents/dev_projects/open-agent-bridge/src/types/messages.ts)

## Agent API

### `GET /.well-known/agent.json`

Devuelve el `AgentCard` del agente.

Campos relevantes:

- `name`
- `description`
- `url`
- `version`
- `capabilities`
- `defaultInputModes`
- `defaultOutputModes`
- `skills`
- extension local `x-open-agent-bridge` con `agentId`, `projectPath`, `projectType`, `wsUrl`

Ejemplo:

```bash
curl http://localhost:5001/.well-known/agent.json
```

### `POST /`

Punto de entrada JSON-RPC 2.0.

Ejemplo base:

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "tasks/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        { "type": "text", "text": "find payment endpoint" }
      ]
    }
  }
}
```

### `GET /health`

Devuelve estado operativo del agente.

Respuesta típica:

```json
{
  "ok": true,
  "agentId": "uuid",
  "projectName": "open-agent-bridge",
  "projectPath": "/ruta/al/proyecto",
  "port": 5001,
  "timestamp": "2026-03-18T00:00:00.000Z"
}
```

### `WS /ws`

Canal WebSocket para JSON-RPC.

Comportamiento actual:

- al conectar, el servidor envia un mensaje `agent.hello`
- luego acepta mensajes JSON-RPC
- responde por el mismo socket

No hay streaming de tareas ya implementado por este canal.

## Métodos JSON-RPC soportados

### `tasks/send`

Crea una tarea, la marca como `working`, resuelve la skill y devuelve el `Task` final.

Entrada mínima:

```json
{
  "message": {
    "role": "user",
    "parts": [
      { "type": "text", "text": "search auth routes" }
    ]
  }
}
```

Metadatos soportados:

- `skillId`
- `input`

Si no se pasa `skillId`, el router intenta inferirlo por heurística:

- `endpoint` / `route` / `api` -> `endpoint-find`
- `search` / `find` / `grep` -> `code-query`
- `file` / `list` -> `file-search`
- `prompt` / `template` -> `prompt-execute`

Respuesta:

- `result` con un `Task`
- si la skill completa bien, el `Task` queda `completed` con un `Artifact` `type=data`
- si falla, el `Task` queda `failed` con mensaje de error

Ejemplo `curl`:

```bash
curl -X POST http://localhost:5001/ \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0",
    "id":"req-1",
    "method":"tasks/send",
    "params":{
      "message":{"role":"user","parts":[{"type":"text","text":"find payment endpoint"}]},
      "metadata":{"skillId":"endpoint-find","input":{"query":"payment"}}
    }
  }'
```

### `tasks/get`

Consulta una tarea por `id`.

Entrada:

```json
{ "id": "task-id" }
```

### `tasks/cancel`

Marca una tarea como `canceled`.

Entrada:

```json
{ "id": "task-id" }
```

### `agent.health`

Devuelve metadatos de salud del agente, incluyendo skills registradas.

### `agent.hello`

Devuelve metadatos simples del agente; tambien se usa como anuncio al conectar por WebSocket.

### `project.info`

Devuelve:

- `agentId`
- `projectName`
- `projectPath`
- `projectType`
- skills disponibles

### `project.files`

Lista archivos de un proyecto hasta cierta profundidad.

Entrada:

```json
{ "depth": 2 }
```

Notas:

- ignora `node_modules`, `.git`, `dist`, `.next`, `__pycache__`, `.venv`
- limita a 50 entradas por nivel

### `project.search`

Hace un `code-query` contra el proyecto.

Entrada:

```json
{
  "query": "paymentRetry",
  "fileGlob": "src/**/*.ts"
}
```

## Registry API

### `POST /agents`

Registra un agente usando `AgentRegistration`.

Campos:

- `agentId`
- `name`
- `url`
- `wsUrl`
- `port`
- `projectPath`
- `projectName`
- `projectType`
- `card`
- `registeredAt`

### `DELETE /agents/:id`

Desregistra un agente.

### `POST /agents/:id/heartbeat`

Actualiza heartbeat y marca al agente como saludable.

### `GET /agents`

Lista agentes. Soporta filtros por query string:

- `skill`
- `project`
- `healthy`

Ejemplo:

```bash
curl 'http://localhost:4999/agents?skill=endpoint-find&healthy=true'
```

### `GET /agents/:id`

Devuelve un `RegistryEntry` concreto.

### `GET /health`

Devuelve salud del registry:

```json
{
  "status": "ok",
  "agents": 2,
  "timestamp": "2026-03-18T00:00:00.000Z"
}
```

### `POST /events`

Recibe eventos de tareas enviados por agentes y los retransmite al dashboard via WebSocket.

Payload esperado:

```json
{
  "agentId": "uuid",
  "agentName": "billing-api",
  "taskId": "task-uuid",
  "state": "completed",
  "skillId": "endpoint-find",
  "timestamp": "2026-03-18T00:00:00.000Z",
  "payload": {}
}
```

## Registry WebSocket

Endpoint:

```text
ws://localhost:4999/ws
```

Eventos emitidos:

```json
{ "type": "snapshot", "agents": [] }
{ "type": "agent.registered", "timestamp": "...", "data": {} }
{ "type": "agent.deregistered", "timestamp": "...", "data": { "agentId": "..." } }
{ "type": "agent.heartbeat", "timestamp": "...", "data": { "agentId": "...", "timestamp": "..." } }
{ "type": "agent.unhealthy", "timestamp": "...", "data": { "agentId": "..." } }
{ "type": "agent.removed", "timestamp": "...", "data": { "agentId": "..." } }
{ "type": "task.update", "timestamp": "...", "data": {} }
```

## Errores JSON-RPC

Códigos definidos:

- `-32700` parse error
- `-32600` invalid request
- `-32601` method not found
- `-32602` invalid params
- `-32603` internal error
- `-32000` task not found
- `-32001` task not cancelable
- `-32002` push notification not supported
- `-32003` unsupported operation

## Limitaciones conocidas

- `tasks/sendSubscribe` esta declarado en tipos y cliente, pero no esta soportado realmente por el servidor.
- `A2AClient.sendTaskSubscribe()` asume SSE, pero `AgentServer` no expone ese flujo hoy.
- La respuesta de `tasks/send` devuelve el `Task` completo y no un stream incremental de artifacts.
