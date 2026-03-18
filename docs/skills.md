# Skills

## Resumen

Las skills builtin se registran en `createDefaultRegistry()` y representan las capacidades operativas por defecto de un agente.

Referencias:

- [`src/skills/index.ts`](/Users/kevin/Documents/dev_projects/mcp-protocol-agentic-connection/src/skills/index.ts)
- [`src/skills/framework.ts`](/Users/kevin/Documents/dev_projects/mcp-protocol-agentic-connection/src/skills/framework.ts)

## Framework

Cada skill extiende `BaseSkill` y define:

- `id`
- `name`
- `description`
- `tags`
- `inputSchema`
- `execute(input, context)`

`SkillRegistry` provee:

- `register(skill)`
- `get(id)`
- `list()`
- `findByTag(tag)`
- `toAgentSkills()`

## `file-search`

Propósito:

- buscar archivos por glob dentro del proyecto

Input:

- `pattern`: glob obligatorio
- `rootDir`: opcional
- `ignore`: opcional, con defaults
- `limit`: opcional, default `100`

Output:

- `files`
- `count`
- `truncated`
- `rootDir`

Ejemplo:

```json
{
  "pattern": "src/**/*.ts",
  "limit": 20
}
```

Caso de uso:

- listar controladores, rutas, DTOs, configs o scripts dentro de un proyecto remoto

## `endpoint-find`

Propósito:

- detectar endpoints y rutas declaradas en el codigo

Input:

- `rootDir`: opcional
- `framework`: `auto | express | nestjs | fastapi | spring | hono | fastify`
- `query`: opcional

Output:

- `endpoints[]`
  - `method`
  - `path`
  - `file`
  - `line`
  - `symbol`
  - `framework`
- `count`
- `query`

Frameworks o patrones cubiertos hoy:

- Express / router style
- NestJS decorators
- FastAPI decorators
- Spring mappings
- algunos patrones tipo Gin/Go

Ejemplo:

```json
{
  "framework": "auto",
  "query": "payment"
}
```

Uso típico:

- ubicar rapidamente rutas HTTP por palabra clave
- inspeccionar proyectos de otros agentes sin abrir manualmente cada archivo

## `code-query`

Propósito:

- buscar texto o regex en archivos de codigo

Input:

- `query`: texto o regex
- `fileGlob`: opcional, default `**/*`
- `rootDir`: opcional
- `maxResults`: opcional, default `50`
- `caseSensitive`: opcional, default `false`

Output:

- `matches[]`
  - `file`
  - `line`
  - `content`
- `count`
- `truncated`
- `query`

Comportamiento relevante:

- intenta compilar `query` como regex
- si falla, la trata como string literal escapado
- ignora binarios y lockfiles

Ejemplo:

```json
{
  "query": "paymentRetry|retryPayment",
  "fileGlob": "src/**/*.ts",
  "maxResults": 25
}
```

## `prompt-execute`

Propósito:

- renderizar un prompt template con placeholders `{{variable}}`

Input:

- `template`
- `variables`
- `context`
- `instruction`

Output:

- `prompt`
- `variablesUsed`
- `variablesMissing`
- `renderedLength`

Ejemplo:

```json
{
  "template": "Explica el flujo de {{feature}} en {{module}}",
  "variables": {
    "feature": "checkout",
    "module": "billing"
  },
  "instruction": "Resume el flujo y destaca riesgos"
}
```

Uso típico:

- preparar prompts reusables para delegación entre agentes
- construir instrucciones con contexto ya interpolado

## Inferencia automática de skill

Si `tasks/send` no recibe `metadata.skillId`, el router intenta inferir una skill a partir del mensaje:

- contiene `endpoint`, `route` o `api` -> `endpoint-find`
- contiene `search`, `find` o `grep` -> `code-query`
- contiene `file` o `list` -> `file-search`
- contiene `prompt` o `template` -> `prompt-execute`

Si no detecta ninguna:

- la tarea completa con una respuesta por defecto de info del proyecto
- no ejecuta ninguna skill

## StateGraph

El paquete tambien exporta `StateGraph` y `CompiledGraph` como primitives inspiradas en LangGraph.

Estado actual:

- permite nodos, edges y conditional edges
- soporta `invoke()` y `stream()`
- mergea estado mediante reducers
- no implementa un runtime completo para convergencia compleja o fan-in robusto

Documenta esto como utilidad experimental, no como subsistema maduro.
