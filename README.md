# agent-bridge

Protocolo local de comunicación entre agentes para terminal y proyectos en desarrollo. `agent-bridge` conecta agentes vía HTTP, WebSocket, JSON-RPC 2.0 y una capa MCP opcional para exponerlos como herramientas consumibles por clientes como Claude Code, Codex o Gemini CLI.

El repositorio tiene dos superficies principales:

- Runtime TypeScript con CLI, registry, agentes A2A, clientes y adaptador MCP.
- Dashboard Vue 3 para visualizar agentes, trazas de tareas y chat básico.

## Estado actual

El proyecto compila hoy y ya cubre el flujo local básico:

- `npm run build` en la raíz compila el backend TypeScript.
- `npm run build` dentro de `dashboard/` compila el frontend Vue.
- El registry expone HTTP y WebSocket en `localhost`.
- Los agentes se registran en el registry, publican heartbeat y emiten eventos de tareas.
- El dashboard consume el WebSocket del registry y permite chat HTTP con agentes.
- El adaptador MCP puede arrancar en `stdio` o HTTP/SSE y autoarrancar infraestructura local.

También hay limitaciones que deben asumirse como parte del comportamiento actual:

- El transporte es local por defecto y hace bind en `localhost`.
- `tasks/sendSubscribe` y el streaming A2A no estan implementados end-to-end.
- `StateGraph` existe, pero su motor aun es parcial.
- No hay autenticación ni endurecimiento de seguridad para uso fuera de entorno local.

## Requisitos

- Node.js `>=22`
- `npm`

## Instalación

```bash
npm install
cd dashboard && npm install
```

## Estructura rápida

```text
.
├── src/
│   ├── agent/       # AgentServer, routing JSON-RPC, Agent Card, detección de proyecto
│   ├── cli/         # Comandos agent-bridge
│   ├── client/      # Clientes para registry y agentes A2A
│   ├── mcp/         # Adaptador MCP
│   ├── registry/    # Registry HTTP + WebSocket + eventos
│   ├── skills/      # Framework de skills y skills builtin
│   └── types/       # Tipos A2A, JSON-RPC y mensajes internos
├── dashboard/       # SPA Vue 3 + Pinia + Vue Router
├── PLAN.md          # Documento de intención inicial del proyecto
└── docs/            # Documentación técnica detallada
```

## Quickstart local

### 1. Levantar el registry

```bash
npm run dev -- registry start
```

Registry por defecto:

- HTTP: `http://localhost:4999`
- WebSocket: `ws://localhost:4999/ws`
- Dashboard servido por el registry si existe `dashboard/dist`: `http://localhost:4999/dashboard`

### 2. Levantar un agente en un proyecto

Desde la raíz de este repositorio o cualquier otro proyecto local:

```bash
npm run dev -- start .
```

Opcionalmente:

```bash
npm run dev -- start . --port 5005
```

Al arrancar, el agente:

- detecta el tipo de proyecto por archivos conocidos
- construye su Agent Card
- expone HTTP y WebSocket
- se registra en el registry
- manda heartbeat cada 30 segundos

### 3. Listar agentes

```bash
npm run dev -- list
```

Con salida JSON:

```bash
npm run dev -- list --json
```

### 4. Enviar una tarea a un agente

```bash
npm run dev -- ask <agent-id-o-nombre> "find payment endpoint"
```

Forzando skill:

```bash
npm run dev -- ask <agent-id-o-nombre> "find payment endpoint" --skill endpoint-find
```

### 5. Delegar por skill

```bash
npm run dev -- delegate endpoint-find "search checkout flow"
```

### 6. Abrir el dashboard

En desarrollo:

```bash
npm run dev:dashboard
```

Luego abre:

```text
http://localhost:5173
```

Si ya compilaste el dashboard y el registry esta arriba:

```bash
npm run dev -- dashboard --no-open
```

### 7. Usar como servidor MCP

Arranque rapido en `stdio`:

```bash
npm run dev -- mcp start
```

Esto intenta:

- detectar si el registry ya existe
- arrancar un registry embebido si no existe
- arrancar un agente local si no hay agentes registrados
- registrar meta-tools MCP y, si aplica, tools por skill/agente

Generar configuracion `.mcp.json`:

```bash
npm run dev -- mcp config
```

## Scripts

### Raíz

| Script | Descripción |
| --- | --- |
| `npm run build` | Compila TypeScript a `dist/` |
| `npm run dev` | Ejecuta la CLI desde `src/cli/index.ts` con `tsx` |
| `npm run start` | Ejecuta la CLI compilada desde `dist/cli/index.js` |
| `npm run clean` | Borra `dist/` |
| `npm run build:dashboard` | Compila solo el dashboard |
| `npm run build:all` | Compila backend, dashboard y copia `dashboard/dist` a `dist/dashboard` |
| `npm run dev:dashboard` | Levanta Vite para el dashboard |

### Dashboard

Dentro de `dashboard/`:

| Script | Descripción |
| --- | --- |
| `npm run dev` | Levanta Vite en `localhost:5173` |
| `npm run build` | Ejecuta `vue-tsc --noEmit` y build de Vite |
| `npm run preview` | Sirve el build del dashboard |

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
| `mcp server` | Arranca el adaptador MCP en HTTP/SSE |
| `mcp config` | Imprime o escribe configuracion MCP |
| `mcp status` | Muestra agentes y tools MCP disponibles |
| `dashboard` | Imprime o abre la URL del dashboard |

La referencia operativa completa esta en [`docs/cli-and-operations.md`](docs/cli-and-operations.md).

## Skills incluidas

El agente por defecto registra cuatro skills builtin:

| Skill | Propósito |
| --- | --- |
| `file-search` | Buscar archivos por glob |
| `endpoint-find` | Detectar endpoints/rutas en varios frameworks |
| `code-query` | Buscar texto o regex en el codigo |
| `prompt-execute` | Renderizar un prompt template con variables |

Mas detalle y ejemplos en [`docs/skills.md`](docs/skills.md).

## Arquitectura

Resumen de alto nivel:

```text
CLI / MCP Client / Dashboard
          |
          v
   RegistryServer (:4999)
   - HTTP /agents, /health, /events
   - WS   /ws
          |
          +---- AgentServer A (:500x)
          |     - GET /.well-known/agent.json
          |     - POST /
          |     - GET /health
          |     - WS /ws
          |
          +---- AgentServer B (:500x)
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
- tipos A2A, JSON-RPC y de skills

Referencias:

- [`src/index.ts`](/Users/kevin/Documents/dev_projects/mcp-protocol-agentic-connection/src/index.ts)
- [`docs/a2a-and-api.md`](docs/a2a-and-api.md)

## Validación actual

Se verificó en este repositorio:

- `npm run build` en la raíz: OK
- `npm run build` en `dashboard/`: OK

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
