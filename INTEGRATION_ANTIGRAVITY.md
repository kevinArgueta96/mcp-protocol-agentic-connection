# Plan de Integración: Antigravity CLI (`agy`) — reemplazo TOTAL de la capa Gemini

> Objetivo: **eliminar por completo** la integración de Gemini CLI y sustituirla por Antigravity CLI (`agy`), usando **únicamente los patrones nativos** del CLI. Sin ACP. Sin tmux como pieza central.

Este plan está fundamentado en inspección **directa del binario instalado** (`/home/kevin-osigu/.local/bin/agy`) y de su estado en disco (`~/.gemini/antigravity-cli/`), no en suposiciones.

---

## 1. El corazón del CLI — qué expone realmente `agy`

### 1.1 Superficie de comandos real (build instalado)
```
Flags:  --add-dir  -c/--continue  --conversation <id>
        --dangerously-skip-permissions  -i/--prompt-interactive
        --log-file  -p/--print (=--prompt)  --print-timeout (5m)  --sandbox
Subcmds: changelog  help  install  plugin/plugins  update
```
- **No existe** `--output-format`, ni `stream-json`, ni `--input-format`, ni modo servidor/daemon, ni JSON-RPC de cara al agente.
- `agy -p "prompt"` = una sola pasada **en texto plano** y termina.
- `agy plugin import [gemini|claude]` → **importa plugins en formato gemini o claude** (skills, agents, rules, MCP, hooks). `install` soporta `plugin@marketplace`.

### 1.2 PATRÓN NATIVO #1 — el "JSON-RPC" de `agy` **es MCP**
La tabla de símbolos del binario muestra `jsonrpc2` usado **solo** como transporte de MCP:
`map[jsonrpc2.ID]*mcp.msgBatch`, `jsonrpc2.AsyncCall`, `jsonrpc2.Message`.
→ **No hay servidor JSON-RPC/ACP/socket donde "empujar" prompts.** `agy` actúa como **cliente MCP**.
**Conclusión:** la forma correcta de exponer el patrón de *channels* es como **servidor MCP** al que `agy` se conecta. Ese es el único "JSON-RPC" nativo.

### 1.3 PATRÓN NATIVO #2 — coordinación multi-agente vía filesystem `.agents/`
El binario contiene **sus propias instrucciones de harness** (extraídas con `strings`):
> *"If you received a NEW message this turn (from user or parent agent), append it to `.agents/ORIGINAL_REQUEST.md` with a UTC timestamp header (e.g. `## 2026-04-17T15:00:00Z`)… dedup by last timestamp header."*
> *"…append it to `.agents/<your_folder>/ORIGINAL_REQUEST.md`…"*
> *"Create working directories under `.agents/` for each planned subagent."*

→ Antigravity ya pasa mensajes **padre→hijo por archivos** en `.agents/`. Es el mecanismo nativo de "llegada de mensajes". (Linaje Codeium/Windsurf: protos `cortex_pb`, `jetski_cortex_pb`, `codeium_common_pb`, `AgentStateUpdate`.)
**Conclusión:** un mensaje entrante del canal se entrega de forma nativa **anexándolo a `.agents/ORIGINAL_REQUEST.md`** con cabecera de timestamp; el agente lo recoge como "nuevo mensaje del agente padre" en su siguiente turno.

### 1.4 PATRÓN NATIVO #3 — hooks de ciclo de vida (auto-continuación)
Eventos: `SessionStart/SessionEnd`, `UserPromptSubmit/Stop/StopFailure`, `PreToolUse/PostToolUse`. Contrato stdin/stdout JSON (camelCase).
El **hook `Stop`** puede devolver `{"decision":"block","reason":"<texto>"}` → **fuerza al agente a continuar** con ese texto. Es el disparador de "auto-arrival".

### 1.5 Estado en disco (`~/.gemini/antigravity-cli/`)
| Ruta | Contenido |
|---|---|
| `conversations/<uuid>.pb` | Conversaciones en **protobuf** (no SQLite en este build). |
| `history.jsonl` | Índice: `{display, timestamp, workspace, conversationId}` → mapea workspace ↔ conversationId. |
| `brain/<conversationId>/` | Artefactos: `task.md`, `implementation_plan.md`, `walkthrough.md` (+ `.metadata.json`, `.resolved.N`). |
| `implicit/<uuid>.pb` | Contexto implícito. |
| `settings.json` | `model`, `trustedWorkspaces`, `statusLine.command` (recibe metadata del agente por stdin). |
| `knowledge/` | Base de conocimiento. |
| `mcp_config.json` | Config MCP (global aquí; por workspace en `.agents/mcp_config.json`). |

---

## 2. Diseño de la integración de *channels* (100% nativo)

```
            open-agent-bridge (registry + canal)
                      │  (servidor MCP: list_agents, channel_inbox, reply, message_client_session)
                      ▼
        ┌──────────────────────────── agy (cliente MCP) ────────────────────────────┐
  IN →  │  (A) append .agents/ORIGINAL_REQUEST.md  +  (D) Stop hook decision:block    │
  OUT ← │  el agente llama reply()/message_client_session() vía MCP                   │
        └────────────────────────────────────────────────────────────────────────────┘
  Push externo sin sesión viva:  agy -p --conversation <id-de-history.jsonl>
  Último recurso (TUI viva):      tmux send-keys
```

### 2.1 Entrada (canal → `agy`) — "llegar automáticamente"
1. **Append a `.agents/ORIGINAL_REQUEST.md`** del workspace: el mensaje del canal con cabecera `## <UTC>` + remitente + conversationId. (Mecanismo nativo del harness.)
2. **Hook `Stop`**: al terminar el turno, consulta el registry; si hay pendientes para este agente, devuelve `{"decision":"block","reason": "<resumen + 'revisa .agents/ORIGINAL_REQUEST.md y responde con channel reply'>"}` → `agy` continúa solo.
3. **Hook `SessionStart`**: registra la sesión `agy` como cliente en el registry y drena backlog.

### 2.2 Salida (`agy` → canal)
El agente usa directamente las tools MCP `reply` / `message_client_session`. Sin scraping ni parsing de stdout.

### 2.3 Push desde un daemon sin sesión interactiva — **VALIDADO en vivo**
Pruebas reales sobre el binario instalado:

| Modo | STDOUT | Veredicto |
|---|---|---|
| `agy -p "<msg>"` (conversación **nueva**) | **Limpio**: solo la respuesta nueva, exit 0. No pide permisos para prompts de solo texto. | ✅ Usar para el relay |
| `agy -p "<msg>" --conversation <id>` | `Info:` + **replay completo del transcript** previo + respuesta nueva al final | ❌ Difícil de relayar |
| `--dangerously-skip-permissions` | Bloqueado por el clasificador auto-mode de Claude Code | ❌ Evitar; innecesario |

**Decisión:** el daemon usa **conversación nueva por mensaje entrante** (stdout trivialmente relayable). La continuidad de hilo se lleva por el archivo nativo `.agents/ORIGINAL_REQUEST.md` + contexto embebido en el prompt — **no** por `--conversation`. El `conversationId` de `history.jsonl` solo se usaría si alguna vez se requiere continuidad por `--conversation`.

### 2.4 Último recurso
`tmux send-keys` para "despertar" un pane TUI vivo y ocioso. Solo fallback.

---

## 3. Empaquetado: un **plugin de Antigravity** instalable

Distribuir todo como un plugin (importable con `agy plugin import claude` o instalable):
```
open-agent-bridge-plugin/
├── mcp_config.json     # registra open-agent-bridge como servidor MCP
├── hooks.json          # Stop → hook-stop ; SessionStart → hook-session-start
└── hooks/
    ├── stop.sh         # → agent-bridge antigravity hook-stop
    └── session-start.sh# → agent-bridge antigravity hook-session-start
```
`mcp_config.json` (servidor local stdio; remoto usaría `serverUrl`):
```json
{ "mcpServers": { "agent-bridge": { "command": "agent-bridge", "args": ["mcp"] } } }
```

---

## 4. Borrado de la capa Gemini (eliminación total)

| Archivo Gemini | Acción |
|---|---|
| `src/client/gemini-acp-bridge.ts` | **Eliminar** |
| `src/client/gemini-acp-client.ts` | **Eliminar** |
| `src/client/gemini-tmux-bridge-service.ts` | **Eliminar** (se reimplementa solo el nudge mínimo si se necesita) |
| `src/client/gemini-runtime-discovery.ts` | **Eliminar** |
| `src/client/gemini-session-files.ts` | **Eliminar** |
| `src/client/profiles/gemini-client-profile.ts` | **Eliminar** |
| `src/cli/commands/gemini.ts` | **Eliminar** |
| `src/client/client-profile-resolver.ts` | **Editar**: quitar rama `gemini`/`gemini-cli`, añadir `antigravity`/`agy`. |
| `src/cli/index.ts` | **Editar**: `registerGeminiCommand` → `registerAntigravityCommand`. |

> Verificar callers con codegraph antes de borrar (`codegraph_impact` sobre cada símbolo) para no romper `index.ts` ni el resolver.

## 5. Archivos nuevos (capa Antigravity)

| Archivo | Rol |
|---|---|
| `src/client/profiles/antigravity-client-profile.ts` | `id="antigravity"`, `deliveryMode="inbox-first"`; mapea mensajes del canal. |
| `src/client/antigravity-runtime-discovery.ts` | Detecta binario `agy`, versión, `~/.gemini/antigravity-cli/`. |
| `src/client/antigravity-history.ts` | Lee `history.jsonl`, resuelve `conversationId` por workspace. |
| `src/client/antigravity-agents-file.ts` | Append/dedup en `.agents/ORIGINAL_REQUEST.md` (cabeceras UTC). |
| `src/client/antigravity-hooks.ts` | Handlers `Stop` / `SessionStart` (stdin/stdout JSON). |
| `src/client/antigravity-headless-bridge.ts` | Daemon push: `agy -p --conversation <id>` + relay. |
| `src/cli/commands/antigravity.ts` | `install-plugin`, `hook-stop`, `hook-session-start`, `start`. |
| `plugin/` (mcp_config.json, hooks.json, hooks/*) | Plugin instalable en `agy`. |

## 6. Secuencia de construcción

1. `antigravity-runtime-discovery.ts` + `antigravity-history.ts` + tests (parsean disco real).
2. `AntigravityClientProfile` + registro en resolver; quitar Gemini del resolver.
3. **Servidor MCP**: confirmar/añadir comando `agent-bridge mcp` y plantilla `mcp_config.json`.
4. `antigravity-agents-file.ts` (append/dedup `.agents/ORIGINAL_REQUEST.md`) + tests.
5. `antigravity-hooks.ts` + comandos `hook-stop`/`hook-session-start` + `hooks.json` + tests del contrato.
6. `antigravity-headless-bridge.ts` (push vía `--conversation`).
7. CLI `antigravity.ts` (`install-plugin`, `start`) + registro en `cli/index.ts`; **eliminar** archivos Gemini.
8. E2E: instalar plugin → abrir `agy` en un workspace → enviar mensaje desde Claude/Codex → confirmar append en `.agents/ORIGINAL_REQUEST.md`, continuación por Stop hook y respuesta por `reply`.
9. README: retiro de Gemini, alta de Antigravity, fecha límite Gemini CLI (2026-06-18).

## 7. Riesgos / pendientes de verificar
- Confirmar la **ruta exacta** que `agy` lee para `mcp_config.json` y `hooks.json` (global `~/.gemini/antigravity-cli/` vs workspace `.agents/`).
- Confirmar que `agy -p --conversation <id>` reanuda de forma fiable y que stdout es la respuesta limpia del agente (sin envoltura TUI).
- El formato `.pb` (protobuf, esquemas `cortex_pb`) es interno y puede cambiar entre versiones → **no** parsear `.pb` directamente; usar `history.jsonl` (estable) + comandos `agy`.
- Confirmar nombre exacto del schema de `hooks.json` (claves de eventos) y campos del Stop hook (`decision`/`reason`/`hookSpecificOutput.additionalContext`).
- `agy plugin import claude`: validar qué subconjunto del formato Claude (skills/hooks/MCP) se importa intacto.

## 8. Fuentes
- Inspección directa: `agy --help`, `~/.gemini/antigravity-cli/` (este equipo).
- [Antigravity Hooks](https://antigravity.google/docs/hooks) · [Using AGY CLI](https://antigravity.google/docs/cli-using) · [CLI Features](https://antigravity.google/docs/cli-features) · [MCP](https://antigravity.google/docs/mcp)
- [Transición Gemini CLI → Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- [Repo oficial google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli) · [Herramienta no oficial (brain/artifacts)](https://github.com/michaelw9999/antigravity-cli)
- [Deep dive — agentpedia](https://agentpedia.codes/blog/antigravity-cli-deep-dive) · [DataCamp](https://www.datacamp.com/tutorial/antigravity-cli)
