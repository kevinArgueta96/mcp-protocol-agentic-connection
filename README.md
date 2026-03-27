# agent-bridge

Protocolo local de comunicación entre agentes para terminal y proyectos en desarrollo. `agent-bridge` conecta agentes vía HTTP, WebSocket, JSON-RPC 2.0 y una capa MCP opcional para exponerlos como herramientas consumibles por clientes como Claude Code, Codex o Gemini CLI.

El repositorio tiene dos superficies principales:

- Runtime TypeScript con CLI, registry, agentes A2A, clientes y adaptador MCP.
- Dashboard Vue 3 para visualizar agentes, trazas de tareas y chat básico.

## Estado actual

El proyecto compila hoy y cubre el flujo local completo:

- `pnpm run build` en la raíz compila el backend TypeScript.
- `pnpm run build` dentro de `dashboard/` compila el frontend Vue.
- El registry expone HTTP y WebSocket en `localhost`.
- Los agentes se registran en el registry, publican heartbeat y emiten eventos de tareas.
- El dashboard consume el WebSocket del registry y permite chat HTTP con agentes.
- El adaptador MCP arranca en `stdio` o HTTP/SSE y autoarranca infraestructura local.
- Canal bidireccional con Claude Code via `claude/channel` — los agentes pueden enviar notificaciones al terminal de Claude y Claude puede responder via `reply`.
- Permission relay — Claude Code reenvía prompts de aprobación de tools al canal para aprobar/denegar de forma remota.
- AG-UI — endpoint SSE compatible con el protocolo AG-UI para streaming de eventos de tareas.

Limitaciones actuales:

- El transporte es local por defecto y hace bind en `localhost`.
- `tasks/sendSubscribe` y el streaming A2A no estan implementados end-to-end.
- `StateGraph` existe, pero su motor aun es parcial.
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
│   │   ├── server.ts          # AgentServer: HTTP + WS + A2A + AG-UI
│   │   ├── handlers.ts        # TaskStore, RequestRouter, skill inference
│   │   ├── card.ts            # Generador de AgentCard A2A
│   │   ├── project-detector.ts# Detección de tipo de proyecto
│   │   └── ag-ui-events.ts    # Helpers para AG-UI SSE events
│   ├── cli/         # Comandos agent-bridge
│   ├── client/      # Clientes para registry y agentes A2A
│   ├── mcp/
│   │   └── adapter.ts         # McpAgentBridge: MCP tools + canal claude/channel
│   ├── registry/    # Registry HTTP + WebSocket + relay + eventos
│   ├── skills/
│   │   ├── framework.ts       # BaseSkill + SkillRegistry
│   │   ├── state-graph.ts     # StateGraph / CompiledGraph
│   │   └── builtins/          # Skills builtin y dinámicos
│   └── types/       # Tipos A2A, JSON-RPC y mensajes internos
├── dashboard/       # SPA Vue 3 + Pinia + Vue Router
├── PLAN.md          # Documento de intención inicial del proyecto
└── docs/            # Documentación técnica detallada
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

Desde la raíz de este repositorio o cualquier otro proyecto local:

```bash
pnpm run dev -- start .
```

Opcionalmente:

```bash
pnpm run dev -- start . --port 5005
```

Al arrancar, el agente:

- detecta el tipo de proyecto por archivos conocidos
- construye su Agent Card
- expone HTTP y WebSocket
- se registra en el registry
- manda heartbeat cada 30 segundos

### 3. Listar agentes

```bash
pnpm run dev -- list
```

Con salida JSON:

```bash
pnpm run dev -- list --json
```

### 4. Enviar una tarea a un agente

```bash
pnpm run dev -- ask <agent-id-o-nombre> "find payment endpoint"
```

Forzando skill:

```bash
pnpm run dev -- ask <agent-id-o-nombre> "find payment endpoint" --skill endpoint-find
```

### 5. Delegar por skill

```bash
pnpm run dev -- delegate endpoint-find "search checkout flow"
```

### 6. Abrir el dashboard

En desarrollo:

```bash
pnpm run dev:dashboard
```

Luego abre:

```text
http://localhost:5173
```

Si ya compilaste el dashboard y el registry esta arriba:

```bash
pnpm run dev -- dashboard --no-open
```

### 7. Usar como servidor MCP

Arranque rápido en `stdio`:

```bash
pnpm run dev -- mcp start
```

Con soporte para `claude-execute` (requiere `ANTHROPIC_API_KEY` en `.env`):

```bash
pnpm run dev -- mcp start --claude
```

Esto intenta:

- detectar si el registry ya existe
- arrancar un registry embebido si no existe
- arrancar un agente local si no hay agentes registrados
- registrar meta-tools MCP (`list_agents`, `agent_health`, `ask_agent`, `reply`)
- si se usa `--skill-tools`, registrar también tools individuales por skill/agente

Generar configuracion `.mcp.json`:

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

Todos salen de `agent-bridge`:

| Comando | Descripción |
| --- | --- |
| `start [path]` | Arranca un agente para un directorio |
| `start --registry` | Arranca el registry desde el comando `start` |
| `registry start` | Arranca el registry |
| `registry status` | Consulta salud del registry |
| `list` | Lista agentes activos |
| `health [agent-id]` | Verifica alcanzabilidad de agentes |
| `ask <agent> <message>` | Envia una tarea a un agente |
| `find <query>` | Busca agentes por skill o proyecto |
| `delegate <skill-id> <message>` | Envia una tarea al mejor agente saludable con esa skill |
| `broadcast <message>` | Envia un mensaje a todos los agentes saludables |
| `mcp start` | Arranca el adaptador MCP en `stdio` |
| `mcp server` | Arranca el adaptador MCP en HTTP/SSE (puerto 6000) |
| `mcp config` | Imprime o escribe configuracion MCP |
| `mcp status` | Muestra agentes y tools MCP disponibles |
| `dashboard` | Imprime o abre la URL del dashboard |

La referencia operativa completa esta en [`docs/cli-and-operations.md`](docs/cli-and-operations.md).

## Skills incluidas

### Skills builtin (siempre disponibles)

El registry por defecto registra 6 skills builtin (`createDefaultRegistry`):

| Skill | Propósito |
| --- | --- |
| `file-search` | Buscar archivos por glob pattern en el proyecto |
| `endpoint-find` | Detectar endpoints/rutas en backends (Express, NestJS, FastAPI, Spring, Gin) o llamadas API en frontends (axios, fetch) |
| `code-query` | Buscar texto o regex en el código fuente |
| `prompt-execute` | Renderizar un prompt template con variables para inyección en un LLM |
| `notify-claude` | Enviar una notificación al terminal de Claude Code via canal `claude/channel` |
| `shell-execute` | Ejecutar un comando shell directamente en el directorio del proyecto |

Con `--claude` (requiere `ANTHROPIC_API_KEY`) se activa `createClaudeRegistry` que agrega:

| Skill | Propósito |
| --- | --- |
| `claude-execute` | Ejecutar análisis o generación de código usando Claude AI (API REST o proceso persistente) |

### Skills dinámicos (detectados automáticamente)

Se registran según los archivos presentes en el proyecto:

| Skill | Condición de activación | Propósito |
| --- | --- | --- |
| `run-script` | `package.json` existe | Ejecutar scripts npm/pnpm/yarn del proyecto |
| `run-tests` | jest/vitest/pytest/pom.xml detectado | Ejecutar la suite de tests |
| `docker-build` | `Dockerfile` existe | Construir imagen Docker |
| `code-review` | directorio `src/` existe | Review de código con Claude AI |

Mas detalle y ejemplos en [`docs/skills.md`](docs/skills.md).

## Canal claude/channel

El adaptador MCP declara las capabilities `claude/channel` y `claude/channel/permission`, habilitando comunicación bidireccional entre agentes y el terminal de Claude Code.

### Flujo de notificación

1. Un agente invoca el skill `notify-claude` con un `content`
2. El registry reenvía la notificación al adaptador MCP via WebSocket
3. El adaptador emite `notifications/claude/channel` — aparece en el terminal de Claude como:

```xml
<channel source="agent-bridge" from_agent="nombre-agente" agent_id="uuid">
  contenido del mensaje
</channel>
```

4. Claude responde usando la meta-tool `reply` con el `agentId` del evento

### Meta-tools MCP disponibles

| Tool | Descripción |
| --- | --- |
| `list_agents` | Lista agentes conectados con sus skills y estado de salud |
| `agent_health` | Verifica si un agente específico está vivo |
| `ask_agent` | Envía mensaje o tarea a un agente (WS relay primero, fallback HTTP) |
| `reply` | Responde a un evento de canal entrante (shorthand de `ask_agent`) |

### Permission relay

Cuando Claude Code muestra un prompt de aprobación de tool, el canal lo reenvía al agente conectado:

```xml
<channel source="agent-bridge" type="permission_request" request_id="abcde" tool_name="Bash">
  Claude wants to run Bash: <descripción>
  Reply "yes abcde" or "no abcde" to approve or deny.
</channel>
```

El agente responde con `yes <id>` o `no <id>` y Claude Code aplica la decisión. El dialog local permanece abierto — la primera respuesta (local o remota) gana.

Referencia oficial: [Channels reference](https://code.claude.com/docs/en/channels-reference)

## Arquitectura

```text
CLI / MCP Client / Dashboard
          |
          v
   RegistryServer (:4999)
   - HTTP /agents, /health, /events
   - HTTP /notify-claude          (push canal → Claude Code)
   - HTTP /agents/:id/message     (relay mensaje a agente via WS)
   - HTTP /agents/:id/ag-ui       (proxy SSE AG-UI sin CORS)
   - WS   /ws                     (snapshot, eventos, relay A2A)
          |
          +---- AgentServer A (:500x)
          |     - GET  /.well-known/agent.json   (A2A Agent Card)
          |     - POST /                          (A2A JSON-RPC)
          |     - POST /ag-ui                     (AG-UI SSE streaming)
          |     - GET  /health
          |     - WS   /ws
          |
          +---- AgentServer B (:500x)
          |
          +---- McpAgentBridge (stdio / :6000)
                - MCP tools: list_agents, agent_health, ask_agent, reply
                - claude/channel capability (notificaciones bidireccionales)
                - claude/channel/permission capability (permission relay)
```

Detalles completos en [`docs/architecture.md`](docs/architecture.md).

## API pública del paquete

La librería exporta:

- `AgentServer`
- `RegistryServer`
- `AgentStore`
- `A2AClient`
- `RegistryClient`
- `McpAgentBridge`
- `BaseSkill`
- `SkillRegistry`
- `StateGraph`
- `CompiledGraph`
- `createDefaultRegistry`
- `createClaudeRegistry`
- tipos A2A, JSON-RPC y de skills

Referencias:

- [`src/index.ts`](src/index.ts)
- [`docs/a2a-and-api.md`](docs/a2a-and-api.md)

## Validación actual

Se verificó en este repositorio:

- `pnpm run build` en la raíz: OK
- `pnpm run build` en `dashboard/`: OK
- Canal `claude/channel` bidireccional: OK (notify-claude → channel event → reply)
- Permission relay: OK

## Documentación detallada

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/cli-and-operations.md`](docs/cli-and-operations.md)
- [`docs/a2a-and-api.md`](docs/a2a-and-api.md)
- [`docs/skills.md`](docs/skills.md)
- [`docs/dashboard.md`](docs/dashboard.md)
- [`docs/development.md`](docs/development.md)

## Notas para mantenedores

- `PLAN.md` describe la visión y la dirección del proyecto, pero no sustituye la documentación operativa.
- `dashboard/ARCHITECTURE.md` sigue siendo útil como documento interno del frontend; `docs/dashboard.md` resume lo necesario a nivel de proyecto.
- Si se implementa streaming real o autenticación, hay que actualizar primero:
  - `README.md`
  - `docs/a2a-and-api.md`
  - `docs/dashboard.md`
  - `docs/cli-and-operations.md`
