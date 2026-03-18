# Desarrollo

## Requisitos

- Node.js `>=22`
- `pnpm`

## Instalación para desarrollo

```bash
pnpm install
cd dashboard && pnpm install
```

## Layout del repositorio

```text
src/
  agent/
  cli/
  client/
  mcp/
  registry/
  skills/
  types/
dashboard/
dist/
PLAN.md
```

## Flujo recomendado

### Backend

Arrancar el registry:

```bash
pnpm run dev -- registry start
```

Arrancar un agente:

```bash
pnpm run dev -- start .
```

Probar operación:

```bash
pnpm run dev -- list
pnpm run dev -- ask <agent> "project info"
```

### Frontend

```bash
pnpm run dev:dashboard
```

## Builds

### Backend

```bash
pnpm run build
```

Salida:

- TypeScript compilado a `dist/`

### Dashboard

```bash
pnpm run build:dashboard
```

Salida:

- Vite build en `dashboard/dist/`

### Build combinado

```bash
pnpm run build:all
```

Acciones:

1. compila backend
2. compila dashboard
3. copia `dashboard/dist` a `dist/dashboard`

## Exportaciones públicas

Desde [`src/index.ts`](/Users/kevin/Documents/dev_projects/mcp-protocol-agentic-connection/src/index.ts):

- servidores: `AgentServer`, `RegistryServer`
- clientes: `A2AClient`, `RegistryClient`
- MCP: `McpAgentBridge`
- skills: `BaseSkill`, `SkillRegistry`, `StateGraph`, `CompiledGraph`, builtin skills
- tipos: A2A, JSON-RPC, skills y mensajes internos

## Detección de proyecto

El agente detecta proyectos por presencia de:

- `package.json` -> `node`
- `Cargo.toml` -> `rust`
- `go.mod` -> `go`
- `pyproject.toml` o `setup.py` -> `python`
- `pom.xml` o `build.gradle` -> `java`

Si no detecta nada:

- tipo `unknown`
- nombre basado en el directorio

## Consideraciones de mantenimiento

- `RegistryServer` usa estado en memoria; reinicios limpian registro de agentes.
- Las tasks tambien viven en memoria dentro de cada `TaskStore`.
- `dashboard/dist` es un artefacto importante si se quiere servir UI desde el registry.
- `dist/` y `dashboard/dist/` ya existen en este repositorio; al documentar no asumir que siempre estan actualizados.

## Limitaciones técnicas visibles

- `A2AClient.sendTaskSubscribe()` y el flujo SSE asociado aun tienen TODOs.
- `StateGraph` no cubre todos los casos de ejecución de grafos complejos.
- No hay tests automatizados dentro del repo hoy; la verificación actual es por builds y pruebas manuales.
- No hay autenticación, autorización ni persistencia.

## Checklist de verificación manual

- `pnpm run build` en la raíz
- `cd dashboard && pnpm run build`
- `pnpm run dev -- registry start`
- `pnpm run dev -- start .`
- `pnpm run dev -- list`
- `pnpm run dev -- ask <agent> "project info"`
- abrir `http://localhost:4999/dashboard` si el dashboard fue compilado
