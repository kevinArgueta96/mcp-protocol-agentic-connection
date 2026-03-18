# agent-bridge — Protocolo Local de Comunicación entre Agentes en Terminal

## Visión

Sistema para que agentes corriendo en diferentes terminales/proyectos locales puedan descubrirse, anunciar su estado, intercambiar contexto y responder solicitudes entre sí. Cada terminal actúa como un **agent endpoint** local que otros agentes pueden consultar o al que pueden delegarle subtareas.

## Decisión de stack: Node.js / TypeScript

| Aspecto | Node.js/TypeScript | Python |
|---|---|---|
| WebSocket async | `ws` library, event loop nativo | `websockets` + asyncio |
| Tipado del protocolo | TypeScript nativo, interfaces para JSON-RPC | Requiere pydantic |
| MCP SDK oficial | `@modelcontextprotocol/sdk` maduro | `mcp` package, menos documentado |
| CLI tooling | `commander`, `chalk` — ecosistema maduro | `click`/`typer` — también maduro |
| Distribución | `npx agent-bridge start` sin instalación | `pip install` + python -m |
| Compatibilidad CLI | Claude Code y Codex usan Node nativamente | Codex usa Python nativamente |

**Ganador: Node.js/TypeScript** — WebSocket + HTTP async es su punto fuerte, el MCP SDK TypeScript es el más maduro, y `npx` permite uso inmediato sin instalación global.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                    Terminal 1 (billing-api)                  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │         AgentServer — WebSocket + HTTP                │  │
│  │   ws://localhost:5001    http://localhost:5001         │  │
│  │   GET /.well-known/agent.json  →  Agent Card          │  │
│  │   POST /  →  JSON-RPC 2.0                             │  │
│  │   WS /ws  →  JSON-RPC 2.0 (real-time)                 │  │
│  │   Skills: file-search, endpoint-find, code-query      │  │
│  └──────────────────────┬────────────────────────────────┘  │
└─────────────────────────┼───────────────────────────────────┘
                          │ register + heartbeat
              ┌───────────▼───────────┐
              │   Registry :4999      │
              │   POST   /agents      │
              │   GET    /agents      │
              │   DELETE /agents/:id  │
              │   GET    /health      │
              └───────────┬───────────┘
                          │ register + heartbeat
┌─────────────────────────┼───────────────────────────────────┐
│  ┌──────────────────────▼────────────────────────────────┐  │
│  │         AgentServer — WebSocket + HTTP                │  │
│  │   ws://localhost:5002    http://localhost:5002         │  │
│  │   Skills: file-search, prompt-execute, code-query     │  │
│  └───────────────────────────────────────────────────────┘  │
│                    Terminal 2 (user-service)                 │
└─────────────────────────────────────────────────────────────┘

         ┌─────────────────────────────────────┐
         │  MCP Adapter  (OPCIONAL)            │
         │  Expone agentes como MCP tools      │
         │  → Claude Code / Codex / Gemini CLI │
         │  StdioTransport + HTTP Transport    │
         └─────────────────────────────────────┘
```

**Principios:**
- **WebSocket** = transporte principal, comunicación real-time entre agentes
- **HTTP** = compatibilidad con spec A2A de Google, health checks
- **JSON-RPC 2.0** = protocolo de mensajes en ambos transportes
- **MCP** = capa adaptadora opcional, NO el núcleo
- **Registry** = descubrimiento en localhost:4999, lightweight HTTP

---

## Protocolo de mensajes (JSON-RPC 2.0)

```json
{
  "jsonrpc": "2.0",
  "id": "uuid-request-123",
  "method": "tasks/send",
  "params": {
    "id": "uuid-task-456",
    "message": {
      "role": "user",
      "parts": [{ "type": "text", "text": "find payment endpoint" }]
    },
    "metadata": { "skillId": "endpoint-find" }
  }
}
```

### Métodos soportados

| Método | Descripción |
|---|---|
| `tasks/send` | Enviar tarea a un agente (sync, espera resultado) |
| `tasks/sendSubscribe` | Enviar tarea con streaming SSE/WebSocket |
| `tasks/get` | Consultar estado de una tarea existente |
| `tasks/cancel` | Cancelar tarea en progreso |
| `agent.hello` | Anuncio de presencia al conectar |
| `agent.health` | Verificar si el agente sigue vivo |
| `project.info` | Obtener nombre, ruta, tipo del proyecto |
| `project.files` | Listar archivos del proyecto |
| `project.search` | Buscar texto en archivos del proyecto |

### Ejemplo de respuesta estructurada

```json
{
  "ok": true,
  "projectName": "billing-api",
  "projectPath": "/Users/kevin/projects/billing-api",
  "query": "find payment endpoint",
  "result": {
    "found": true,
    "type": "endpoint",
    "location": "src/modules/payments/payment.controller.ts",
    "symbol": "POST /payments/create",
    "reason": "Found controller route matching payment creation flow",
    "confidence": 0.93
  },
  "nextSuggestedAction": "Open payment.controller.ts and review service dependency chain"
}
```

---

## Estructura de archivos

```
agent-bridge/
├── package.json
├── tsconfig.json
├── src/
│   ├── types/
│   │   ├── a2a.ts            # AgentCard, Task, TaskState, Message, Part, Artifact
│   │   ├── jsonrpc.ts        # JsonRpcRequest, JsonRpcResponse, JsonRpcError
│   │   ├── messages.ts       # AgentRegistration, AgentHeartbeat, RegistryEntry
│   │   ├── skills.ts         # SkillDefinition, SkillHandler, SkillContext, StateReducer
│   │   └── index.ts
│   ├── skills/
│   │   ├── framework.ts      # BaseSkill (abstract), SkillRegistry
│   │   ├── state-graph.ts    # StateGraph<S>, CompiledGraph<S> — LangGraph-inspired
│   │   ├── builtins/
│   │   │   ├── file-search.ts    # glob → { files: string[] }
│   │   │   ├── endpoint-find.ts  # regex scan → { endpoints: { method, path, file }[] }
│   │   │   ├── code-query.ts     # grep → { matches: { file, line, content }[] }
│   │   │   └── prompt-execute.ts # template render → { prompt: string }
│   │   └── index.ts
│   ├── agent/
│   │   ├── project-detector.ts  # detecta package.json/Cargo.toml/go.mod/pyproject.toml
│   │   ├── card.ts              # genera AgentCard desde contexto del proyecto
│   │   ├── handlers.ts          # TaskStore + RequestRouter (JSON-RPC dispatch)
│   │   ├── server.ts            # AgentServer: Express HTTP + ws WebSocket
│   │   └── index.ts
│   ├── registry/
│   │   ├── store.ts             # AgentStore in-memory, heartbeat/health tracking
│   │   ├── server.ts            # RegistryServer Express en :4999
│   │   └── index.ts
│   ├── client/
│   │   ├── a2a-client.ts        # A2AClient: fetch HTTP + WebSocket para agentes
│   │   ├── registry-client.ts   # RegistryClient: consultar el registry
│   │   └── index.ts
│   ├── mcp/
│   │   ├── adapter.ts           # McpAgentBridge: skills → MCP tools
│   │   └── index.ts
│   ├── cli/
│   │   ├── index.ts             # Commander entry point (#!/usr/bin/env node)
│   │   └── commands/
│   │       ├── start.ts         # agent-bridge start [path] [--port] [--mcp]
│   │       ├── registry.ts      # agent-bridge registry start
│   │       ├── list.ts          # agent-bridge list [--json]
│   │       ├── health.ts        # agent-bridge health [agent-id]
│   │       ├── ask.ts           # agent-bridge ask <agent> <message> [--stream]
│   │       ├── find.ts          # agent-bridge find <query>
│   │       ├── delegate.ts      # agent-bridge delegate <skill> <message>
│   │       └── broadcast.ts     # agent-bridge broadcast <message>
│   └── index.ts                 # Exports públicos de la librería
```

---

## Plan de implementación (orden de construcción)

### Paso 1 — Scaffolding
- `package.json` con `"type": "module"`, deps, bin entry
- `tsconfig.json` target ES2022, module Node16, strict

**Dependencias:**
```
express@^5  ws@^8  commander@^13  zod@^3.25  uuid@^11  chalk@^5  glob@^11
@modelcontextprotocol/sdk@^1.27
```
**Dev:** `typescript@^5.7  tsx  @types/express  @types/ws  @types/node`

### Paso 2 — Core Types (`src/types/`)
- `jsonrpc.ts`: Request, Response, Error con códigos estándar (-32700, -32601, etc.)
- `a2a.ts`: AgentCard, AgentSkill, Task, TaskState enum, TaskStatus, Message, TextPart | FilePart | DataPart, Artifact, TaskSendParams
- `messages.ts`: AgentRegistration, AgentHeartbeat, RegistryEntry
- `skills.ts`: SkillDefinition, SkillContext, StateReducer (`"replace" | "append" | fn`)

### Paso 3 — Skills Framework (`src/skills/`)
- `framework.ts`: `abstract class BaseSkill` con execute(), `class SkillRegistry` (Map + toAgentSkills())
- `state-graph.ts`: `class StateGraph<S>` con addNode/addEdge/addConditionalEdge/compile(). `class CompiledGraph<S>` con invoke()/stream(). Reducers aplicados al mergear estado por nodo
- `builtins/`: file-search (glob), endpoint-find (regex patterns por framework), code-query (grep recursivo), prompt-execute (template render)

### Paso 4 — Agent infraestructura (`src/agent/`)
- `project-detector.ts`: check package.json → Node, Cargo.toml → Rust, go.mod → Go, pyproject.toml → Python, pom.xml → Java
- `card.ts`: genera AgentCard con nombre del proyecto, URL, capabilities, skills
- `handlers.ts`: `class TaskStore` (Map<id,Task>), `class RequestRouter` (JSON-RPC method dispatch → skill execution)
- `server.ts`: `class AgentServer` — levanta Express + ws en mismo httpServer. GET /.well-known/agent.json, POST / (JSON-RPC), GET /health, WS /ws. Se registra en registry al start(), heartbeat cada 30s, deregistra al stop()

### Paso 5 — Registry (`src/registry/`)
- `store.ts`: `class AgentStore` — register/deregister/heartbeat/list/findBySkill/findByProject. healthCheck() marca unhealthy >90s, elimina >300s
- `server.ts`: Express :4999 — POST/DELETE/GET /agents, POST /agents/:id/heartbeat, GET /health

### Paso 6 — Clients (`src/client/`)
- `a2a-client.ts`: `class A2AClient(baseUrl)` — getCard(), sendTask(), getTask(), cancelTask(), sendTaskSubscribe() (streaming)
- `registry-client.ts`: `class RegistryClient` — listAgents(filter?), getAgent(id), findAgentByProject(path)

### Paso 7 — MCP Adapter OPCIONAL (`src/mcp/`)
- `adapter.ts`: `class McpAgentBridge` — consulta registry, por cada agente+skill registra MCP tool. Meta-tools: `list_agents`, `ask_agent`, `agent_info`. Soporta StdioServerTransport y StreamableHTTPServerTransport

### Paso 8 — CLI (`src/cli/`)
- Commander con 8 subcomandos, soporte `--json` para output parseable por scripts/agentes

### Paso 9 — Exports y verificación
- `src/index.ts` re-exporta APIs públicas
- Prueba de integración end-to-end

---

## Flujo de uso completo

```bash
# Terminal 1 — levantar el registry
agent-bridge registry start
# → Registry escuchando en http://localhost:4999

# Terminal 2 — levantar agente en proyecto billing-api
cd /projects/billing-api
agent-bridge start .
# → AgentServer en ws://localhost:5001
# → Registrado en registry como "billing-api"

# Terminal 3 — levantar agente en proyecto user-service
cd /projects/user-service
agent-bridge start .
# → AgentServer en ws://localhost:5002
# → Registrado en registry como "user-service"

# Terminal 4 — consultar agentes activos
agent-bridge list
# → billing-api  :5001  /projects/billing-api  node  ✓ healthy
# → user-service :5002  /projects/user-service  node  ✓ healthy

# Preguntar a un agente dónde está un endpoint
agent-bridge ask billing-api "find payment endpoint"
# → { found: true, location: "src/payments/controller.ts", symbol: "POST /payments/create" }

# Delegar una tarea por skill
agent-bridge delegate endpoint-find "search checkout flow" --agent billing-api

# Health check
agent-bridge health
# → todos los agentes con estado

# Usar desde Claude Code via MCP (opcional)
# Agregar en .mcp.json:
# { "mcpServers": { "agent-bridge": { "command": "agent-bridge", "args": ["mcp"] } } }
```

---

## Prompt para Codex

Copia este prompt completo a Codex para que construya el sistema:

```
Construye un sistema completo en TypeScript/Node.js llamado "agent-bridge" que implementa
un protocolo local de comunicación entre agentes en terminal.

CONTEXTO:
Tengo múltiples terminales abiertas en diferentes proyectos. Necesito que cada terminal
pueda levantar un "agente" que se anuncia en un registry local, dice en qué carpeta está,
qué puede hacer (skills), y responde solicitudes de otros agentes vía WebSocket y HTTP.

ARQUITECTURA EXACTA:
- Registry central en localhost:4999 (HTTP Express) para descubrimiento de agentes
- Cada agente levanta un servidor WebSocket (ws library) + HTTP (Express) en un puerto
  auto-asignado empezando en 5001
- Protocolo de mensajes: JSON-RPC 2.0 en AMBOS transportes (HTTP y WebSocket)
- Cada agente expone su identidad en GET /.well-known/agent.json (formato A2A de Google)
- Skills system inspirado en LangGraph: StateGraph<S> con addNode/addEdge/compile()
- MCP adapter OPCIONAL usando @modelcontextprotocol/sdk para que Claude Code/Codex puedan
  usar los agentes como tools MCP

ESTRUCTURA DE ARCHIVOS (crear exactamente esta):

src/types/
  a2a.ts        — AgentCard, AgentSkill, AgentCapabilities, Task, TaskState enum,
                  TaskStatus, Message, TextPart|FilePart|DataPart, Artifact, TaskSendParams
  jsonrpc.ts    — JsonRpcRequest, JsonRpcResponse, JsonRpcError (códigos -32700 a -32603)
  messages.ts   — AgentRegistration, AgentHeartbeat, RegistryEntry
  skills.ts     — SkillDefinition, SkillHandler<TInput,TOutput>, SkillContext, StateReducer
  index.ts      — re-exports

src/skills/
  framework.ts         — abstract class BaseSkill (id,name,description,tags,inputSchema Zod,
                         abstract execute()), class SkillRegistry (Map, register/get/list/
                         findByTag/toAgentSkills())
  state-graph.ts       — class StateGraph<S extends Record<string,unknown>> con
                         addNode(name, fn:(state:S)=>Promise<Partial<S>>),
                         addEdge(from,to), addConditionalEdge(from, condition fn, targets),
                         setEntryPoint(name), compile() → CompiledGraph<S>.
                         class CompiledGraph<S> con invoke(input:Partial<S>):Promise<S>
                         y stream():AsyncGenerator<{node:string,state:S}>.
                         Reducers: "replace" (default), "append" (arrays), custom fn.
  builtins/file-search.ts   — input:{pattern:string, rootDir?:string} → glob → {files:string[]}
  builtins/endpoint-find.ts — escanea regex de Express/NestJS/FastAPI/Spring en archivos
                               → {endpoints:{method,path,file,line}[]}
  builtins/code-query.ts    — input:{query:string, fileGlob?:string} → grep recursivo
                               → {matches:{file,line,content}[]}
  builtins/prompt-execute.ts — input:{template:string, variables:Record<string,string>}
                                → {prompt:string} (reemplaza {{variable}} en template)
  index.ts — re-exports + createDefaultRegistry():SkillRegistry

src/agent/
  project-detector.ts — detectProjectType(dir):Promise<{type,name,rootDir,configFile}>
                         Detecta: package.json→node, Cargo.toml→rust, go.mod→go,
                         pyproject.toml→python, pom.xml→java, fallback→unknown
  card.ts             — generateAgentCard({port, projectInfo, skills}):AgentCard
  handlers.ts         — class TaskStore (Map<id,Task>, create/get/update/cancel)
                         class RequestRouter (Map<method,handler>, dispatch(req):Promise<res>)
  server.ts           — class AgentServer({port?,projectPath?,skills?}).
                         start():Promise<{port,agentId}> — levanta Express+ws en mismo
                         httpServer, registra en registry, heartbeat 30s.
                         stop():Promise<void> — deregistra, cierra.
                         Rutas HTTP: GET /.well-known/agent.json, POST / (JSON-RPC),
                         GET /health. WebSocket: /ws acepta JSON-RPC mensajes.
  index.ts — re-exports

src/registry/
  store.ts  — class AgentStore. register/deregister/heartbeat/get/list/findBySkill/
               findByProject. healthCheck() marca unhealthy >90s, remove >300s sin heartbeat
  server.ts — class RegistryServer en :4999. Express routes:
               POST /agents, DELETE /agents/:id, POST /agents/:id/heartbeat,
               GET /agents (?skill=tag, ?project=path), GET /agents/:id, GET /health.
               Inicia healthCheck interval cada 60s.
  index.ts — re-exports

src/client/
  a2a-client.ts      — class A2AClient(baseUrl:string).
                        getCard():Promise<AgentCard>
                        sendTask(params):Promise<Task>
                        getTask(id):Promise<Task>
                        cancelTask(id):Promise<Task>
                        sendTaskSubscribe(params):AsyncGenerator<TaskStatusUpdate>
                        private rpc(method,params):Promise<unknown>
  registry-client.ts — class RegistryClient(registryUrl='http://localhost:4999').
                        listAgents(filter?:{skill?,project?}):Promise<RegistryEntry[]>
                        getAgent(id):Promise<RegistryEntry>
                        findAgentByProject(path):Promise<RegistryEntry|undefined>
  index.ts — re-exports

src/mcp/
  adapter.ts — class McpAgentBridge({registryUrl?:string}).
                start(transport:'stdio'|'http', httpPort?:number):Promise<void>
                Crea McpServer de @modelcontextprotocol/sdk/server/mcp.js.
                Por cada agente en registry: fetch AgentCard, registra MCP tool por skill.
                Tool name: {agentName}_{skillId} (ej: billing-api_endpoint-find).
                Meta-tools: list_agents, ask_agent (agentId+message), agent_info, refresh_agents.
                Transports: StdioServerTransport o StreamableHTTPServerTransport.
  index.ts — re-exports

src/cli/
  index.ts — Commander program, #!/usr/bin/env node, parsea process.argv
  commands/
    start.ts     — agent-bridge start [path] [--port N] [--mcp] [--no-registry]
    registry.ts  — agent-bridge registry start [--port N]
    list.ts      — agent-bridge list [--skill tag] [--json]
    health.ts    — agent-bridge health [agentId] [--json]
    ask.ts       — agent-bridge ask <agentId> <message> [--skill id] [--stream] [--json]
    find.ts      — agent-bridge find <query> [--json]
    delegate.ts  — agent-bridge delegate <skillId> <message> [--json]
    broadcast.ts — agent-bridge broadcast <message> [--json]

src/index.ts — re-exporta AgentServer, RegistryServer, McpAgentBridge, A2AClient,
               RegistryClient, StateGraph, BaseSkill, SkillRegistry, todos los tipos

DEPENDENCIAS package.json:
{
  "name": "agent-bridge",
  "version": "0.1.0",
  "type": "module",
  "bin": { "agent-bridge": "./dist/cli/index.js" },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli/index.ts",
    "start": "node dist/cli/index.js"
  },
  "dependencies": {
    "express": "^5.2.1",
    "ws": "^8.18.0",
    "commander": "^13.0.0",
    "zod": "^3.25.0",
    "uuid": "^11.0.0",
    "chalk": "^5.3.0",
    "glob": "^11.0.0",
    "@modelcontextprotocol/sdk": "^1.27.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/express": "^5.0.0",
    "@types/ws": "^8.5.0",
    "@types/node": "^22.0.0",
    "@types/uuid": "^10.0.0"
  }
}

tsconfig.json:
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}

PROTOCOLO JSON-RPC 2.0 (mismo formato en HTTP y WebSocket):
Request:  { jsonrpc:"2.0", id:"uuid", method:"tasks/send", params:{...} }
Response: { jsonrpc:"2.0", id:"uuid", result:{...} }
Error:    { jsonrpc:"2.0", id:"uuid", error:{code:-32601, message:"Method not found"} }

FLUJO DE EJEMPLO A IMPLEMENTAR:
1. Registry en :4999 acepta registros de agentes
2. AgentServer detecta proyecto, genera Agent Card, se registra en registry
3. Heartbeat cada 30s mantiene el agente marcado como healthy
4. CLI `list` consulta registry y muestra agentes activos
5. CLI `ask billing-api "find payment endpoint"` → manda JSON-RPC tasks/send →
   agente ejecuta skill endpoint-find → responde con estructura JSON
6. MCP adapter expone todo como tools para Claude Code/Codex

NOTAS CRÍTICAS:
- NO uses CommonJS (require). Todo ESM con import/export
- WebSocket usa la librería `ws`, NO la Web API nativa
- Express 5 tiene async error handling nativo (no necesita next(err))
- Para SSE streaming: Content-Type: text/event-stream, Cache-Control: no-cache
- MCP stdio adapter: NUNCA escribir a stdout, solo stderr para logs
- JSON-RPC id puede ser string o number, manejar ambos
- El puerto del agente se determina dinámicamente: intenta 5001, incrementa en EADDRINUSE
```

---

## Verificación end-to-end

```bash
pnpm run build                          # Debe compilar sin errores TypeScript
agent-bridge registry start            # Registry en :4999
agent-bridge start . --port 5001       # Agente en :5001
agent-bridge start ~/other-project     # Agente en :5002
agent-bridge list                      # Muestra 2 agentes activos
agent-bridge health                    # Ambos healthy
agent-bridge ask <id> "find endpoints" # Respuesta estructurada JSON
agent-bridge ask <id> "list files" --json | jq .  # Parseable por scripts
```