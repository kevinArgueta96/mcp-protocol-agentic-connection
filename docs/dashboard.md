# Dashboard

## Resumen

El dashboard es una SPA Vue 3 para observar agentes conectados, ver eventos de tareas y enviar mensajes simples a un agente.

Tecnologías:

- Vue 3
- Pinia
- Vue Router
- Vite
- Tailwind CSS v4
- `@vueuse/core` para WebSocket

Referencias:

- [`dashboard/package.json`](/Users/kevin/Documents/dev_projects/open-agent-bridge/dashboard/package.json)
- [`dashboard/ARCHITECTURE.md`](/Users/kevin/Documents/dev_projects/open-agent-bridge/dashboard/ARCHITECTURE.md)

## Arranque

### Desarrollo

```bash
cd dashboard
pnpm run dev
```

Por defecto:

- Vite en `http://localhost:5173`
- proxy a `http://localhost:4999` para `/agents`, `/health`, `/events`
- proxy WebSocket a `ws://localhost:4999/ws`

### Build

```bash
cd dashboard
pnpm run build
```

### Servido desde el registry

Si `dashboard/dist` existe, el registry sirve archivos estaticos en:

```text
http://localhost:4999/dashboard
```

Si no existe, responde:

```text
Dashboard not built. Run: pnpm run build:dashboard
```

## Variables de entorno

Definidas en [`dashboard/.env.example`](/Users/kevin/Documents/dev_projects/open-agent-bridge/dashboard/.env.example):

- `VITE_REGISTRY_URL=http://localhost:4999`
- `VITE_REGISTRY_WS=ws://localhost:4999/ws`

Defaults en código:

- registry HTTP: `http://localhost:4999`
- registry WS: `ws://localhost:4999/ws`

## Vistas

### `DashboardView`

Layout de tres paneles:

- izquierda: agentes
- centro: timeline de trazas
- derecha: chat

Referencia:

- [`dashboard/src/views/DashboardView.vue`](/Users/kevin/Documents/dev_projects/open-agent-bridge/dashboard/src/views/DashboardView.vue)

### `AgentDetailView`

Detalle de un agente:

- salud
- conexión
- datos del proyecto
- lista de skills
- Agent Card completa

Referencia:

- [`dashboard/src/views/AgentDetailView.vue`](/Users/kevin/Documents/dev_projects/open-agent-bridge/dashboard/src/views/AgentDetailView.vue)

## Stores

### `useRegistryStore`

Responsabilidades:

- conectarse a `VITE_REGISTRY_WS`
- mantener `Map<agentId, RegistryAgent>`
- procesar `snapshot` y eventos de agente
- reconectar con backoff exponencial

Referencia:

- [`dashboard/src/stores/registry.ts`](/Users/kevin/Documents/dev_projects/open-agent-bridge/dashboard/src/stores/registry.ts)

### `useTraceStore`

Responsabilidades:

- escuchar `task.update`
- mantener buffer circular de eventos
- filtrar por agente, skill o estado

Referencia:

- [`dashboard/src/stores/trace.ts`](/Users/kevin/Documents/dev_projects/open-agent-bridge/dashboard/src/stores/trace.ts)

### `useChatStore`

Responsabilidades:

- mantener agente seleccionado
- enviar `tasks/send` por HTTP al agente
- formatear la respuesta en mensajes de chat

Referencia:

- [`dashboard/src/stores/chat.ts`](/Users/kevin/Documents/dev_projects/open-agent-bridge/dashboard/src/stores/chat.ts)

## Comportamiento del chat

El chat:

- no usa un protocolo AG-UI real en runtime, aunque haya dependencias relacionadas
- envia una petición JSON-RPC `tasks/send` por HTTP
- toma `artifacts` de la respuesta y los concatena a texto
- modela un estado `streaming` en UI, pero no recibe chunks reales

Esto debe documentarse como chat sin streaming real.

## Componentes visibles

- `AppHeader`
- `AgentGrid`
- `AgentCard`
- `TraceTimeline`
- `TraceFilters`
- `TraceEntry`
- `PayloadViewer`
- `AgentChat`
- `AgentSelector`
- `ChatMessage`

## Flujo de datos

```text
Registry WS (/ws)
  -> useRegistryStore actualiza agentes
  -> useTraceStore agrega task.update

Chat UI
  -> POST JSON-RPC tasks/send al AgentServer
  -> respuesta Task
  -> artifacts renderizados en el panel derecho
```

## Riesgos y limitaciones actuales

- Depende totalmente del registry para estado en tiempo real.
- Si el registry no esta arriba, la UI queda sin agentes ni trazas.
- El chat no hace streaming verdadero aunque la UI muestre un estado de envio.
- La ruta `/dashboard` servida por el registry depende de que exista un build previo del dashboard.
