# CLI y Operación

## Resumen

La CLI publica se registra en [`src/cli/index.ts`](/Users/kevin/Documents/dev_projects/mcp-protocol-agentic-connection/src/cli/index.ts) y se distribuye bajo el binario `agent-bridge`.

En desarrollo, los ejemplos de este documento usan:

```bash
npm run dev -- <comando>
```

Con build compilado, el equivalente es:

```bash
agent-bridge <comando>
```

## Comandos principales

### `start [path]`

Arranca un agente para el directorio indicado.

Opciones:

- `-p, --port <number>`: puerto deseado
- `--registry`: arranca el registry en lugar de un agente
- `--mcp`: arranca el adaptador MCP en `stdio`
- `--registry-url <url>`: URL del registry

Ejemplos:

```bash
npm run dev -- start .
npm run dev -- start /ruta/al/proyecto --port 5007
npm run dev -- start . --registry-url http://localhost:4999
```

Comportamiento:

- si `--registry` esta activo, crea `RegistryServer`
- si `--mcp` esta activo, crea `McpAgentBridge`
- si no, crea `AgentServer`

### `registry start`

Arranca el registry HTTP/WS.

Opciones:

- `-p, --port <number>`: puerto del registry, default `4999`

Ejemplo:

```bash
npm run dev -- registry start
```

### `registry status`

Consulta `GET /health` del registry.

Opciones:

- `--registry-url <url>`: default `http://localhost:4999`

Ejemplo:

```bash
npm run dev -- registry status
```

### `list`

Lista los agentes activos.

Opciones:

- `--skill <tag>`: filtra por tag o `skill.id`
- `--project <path>`: filtra por nombre o path de proyecto
- `--json`: salida JSON
- `--registry-url <url>`

Ejemplos:

```bash
npm run dev -- list
npm run dev -- list --skill endpoint-find
npm run dev -- list --project billing
npm run dev -- list --json
```

### `health [agent-id]`

Verifica salud de un agente concreto o de todos.

Opciones:

- `--json`
- `--registry-url <url>`

Ejemplos:

```bash
npm run dev -- health
npm run dev -- health 7c3cc0aa
```

Comportamiento:

- primero consulta el registry
- luego llama `GET /health` de cada agente
- marca como `unreachable` si el agente no responde

### `ask <agent-id> <message>`

Envia una tarea a un agente.

Opciones:

- `--skill <id>`: fuerza una skill concreta
- `--json`
- `--stream`: declarado en CLI, pero el flujo streaming no esta implementado end-to-end
- `--registry-url <url>`

Ejemplos:

```bash
npm run dev -- ask billing-api "find payment endpoint"
npm run dev -- ask billing-api "list files" --skill file-search
npm run dev -- ask 7c3cc0aa "auth route" --skill endpoint-find
```

Resolución del agente:

- intenta `registry.getAgent(agentId)`
- si falla, busca por nombre parcial o prefijo de `agentId`

### `find <query>`

Busca agentes por skill o proyecto.

Opciones:

- `--json`
- `--registry-url <url>`

Ejemplos:

```bash
npm run dev -- find endpoint-find
npm run dev -- find billing
```

### `delegate <skill-id> <message>`

Busca agentes saludables con una skill y usa el primero disponible.

Opciones:

- `--json`
- `--registry-url <url>`

Ejemplo:

```bash
npm run dev -- delegate code-query "search for paymentRetry"
```

Comportamiento actual:

- filtra por `healthy: true`
- toma `agents[0]`
- no aplica ranking adicional

### `broadcast <message>`

Envia la misma tarea a todos los agentes saludables.

Opciones:

- `--json`
- `--registry-url <url>`

Ejemplo:

```bash
npm run dev -- broadcast "project info"
```

La salida usa `Promise.allSettled`, por lo que cada agente puede fallar sin abortar todo el broadcast.

## MCP

### `mcp start`

Arranca `McpAgentBridge` en `stdio`.

Opciones:

- `--registry-url <url>`
- `--project <path>`
- `--no-auto`
- `--no-skill-tools`

Ejemplo:

```bash
npm run dev -- mcp start
```

Auto mode actual:

- si no hay registry en `localhost:4999`, arranca uno embebido
- si no hay agentes saludables, arranca un agente local para `cwd` o `AGENT_BRIDGE_PROJECT`

### `mcp server`

Arranca el adaptador MCP en HTTP/SSE.

Opciones:

- `-p, --port <number>`: default `6000`
- `--registry-url <url>`

Ejemplo:

```bash
npm run dev -- mcp server --port 6000
```

Endpoints expuestos:

- `GET /`
- `GET /mcp`
- `POST /mcp/message`

### `mcp config`

Imprime o escribe configuracion `.mcp.json`.

Opciones:

- `--write`
- `--global`

Ejemplos:

```bash
npm run dev -- mcp config
npm run dev -- mcp config --write
npm run dev -- mcp config --write --global
```

### `mcp status`

Muestra:

- agentes saludables conectados
- meta-tools MCP
- tools por agente/skill
- resources disponibles

Ejemplo:

```bash
npm run dev -- mcp status
```

## Dashboard

### `dashboard`

Imprime la URL del dashboard y, salvo que se desactive, intenta abrir el navegador.

Opciones:

- `--no-open`
- `--port <number>`: default `4999`

Ejemplo:

```bash
npm run dev -- dashboard --no-open
```

## Operación típica

### Flujo mínimo

```bash
npm run dev -- registry start
npm run dev -- start .
npm run dev -- list
npm run dev -- ask <agent-id> "project info"
```

### Flujo con dashboard

Terminal 1:

```bash
npm run dev -- registry start
```

Terminal 2:

```bash
npm run dev -- start .
```

Terminal 3:

```bash
npm run dev:dashboard
```

## Señales operativas importantes

- El registry y los agentes hacen bind en `localhost`.
- El registry no persiste datos; reiniciar el proceso limpia el estado.
- El dashboard servido por el registry requiere que exista `dashboard/dist`.
- `build:all` copia `dashboard/dist` a `dist/dashboard`, pero el registry en runtime consulta `../../dashboard/dist` relativo al archivo compilado. En la práctica conviene compilar el dashboard en su carpeta original antes de usar `/dashboard`.

## Errores y limitaciones frecuentes

- Si `list`, `find`, `health`, `delegate` o `broadcast` fallan, primero valida que el registry este arriba.
- Si un agente aparece en el registry pero `health` lo marca como `unreachable`, valida que siga escuchando en su puerto.
- `ask --stream` no debe documentarse como funcional; hoy solo existe la bandera en la CLI.
- No hay selección inteligente de agente en `delegate`; solo usa el primer match saludable.
