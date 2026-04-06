// Registry HTTP server — central discovery service on :4999
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { AgentStore } from "./store.js";
import { RegistryEventBus } from "./events.js";
import { ChannelStore } from "./channel-store.js";
import type { RegistryEvent } from "./events.js";
import type {
  AgentRegistration,
  AgentListFilter,
  AgentMessage,
  ChannelAck,
  ChannelMessage,
} from "../types/messages.js";

const REGISTRY_PORT = 4999;
const HEALTH_CHECK_INTERVAL_MS = 60_000;

const dashboardDir = new URL("../../dashboard/dist", import.meta.url).pathname;

export class RegistryServer {
  private eventBus = new RegistryEventBus();
  private store = new AgentStore(this.eventBus);
  private channelStore = new ChannelStore();
  private app = express();
  private httpServer: ReturnType<typeof createServer> | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private wsClients = new Set<WebSocket>();
  private agentWsMap = new Map<string, WebSocket>();

  constructor(private readonly port = REGISTRY_PORT) {
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // CORS headers for browser access
    this.app.use((_req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      next();
    });

    // Handle preflight (Express 5 requires named wildcard)
    this.app.options("/{*path}", (_req, res) => {
      res.sendStatus(204);
    });

    // Dashboard static files
    if (existsSync(dashboardDir)) {
      this.app.use("/dashboard", express.static(dashboardDir));
    } else {
      this.app.get("/dashboard", (_req, res) => {
        res.status(503).send(
          "Dashboard not built. Run: pnpm run build:dashboard"
        );
      });
    }

    // Register an agent
    this.app.post("/agents", (req, res) => {
      const registration = req.body as AgentRegistration;
      const entry = this.store.register(registration);
      res.status(201).json(entry);
    });

    // Deregister an agent
    this.app.delete("/agents/:id", (req, res) => {
      const removed = this.store.deregister(req.params.id);
      res.json({ removed });
    });

    // Heartbeat
    this.app.post("/agents/:id/heartbeat", (req, res) => {
      const updated = this.store.heartbeat(req.params.id);
      if (!updated) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json({ ok: true, timestamp: Date.now() });
    });

    // List agents (with optional filters)
    this.app.get("/agents", (req, res) => {
      const filter: AgentListFilter = {
        skill: req.query.skill as string | undefined,
        project: req.query.project as string | undefined,
        healthy: req.query.healthy === "true" ? true : req.query.healthy === "false" ? false : undefined,
      };
      res.json(this.store.list(filter));
    });

    // Get specific agent
    this.app.get("/agents/:id", (req, res) => {
      const entry = this.store.get(req.params.id);
      if (!entry) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json(entry);
    });

    // Registry health
    this.app.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        agents: this.store.count(),
        wsConnections: this.agentWsMap.size,
        wsDashboardClients: this.wsClients.size,
        timestamp: new Date().toISOString(),
      });
    });

    // AG-UI SSE proxy — forward streaming from dashboard → agent
    // Avoids cross-origin fetch issues; dashboard uses /agents/:id/ag-ui (same-origin via proxy)
    this.app.post("/agents/:id/ag-ui", async (req, res) => {
      const entry = this.store.get(req.params.id);
      if (!entry || !entry.url) {
        res.status(404).json({ error: "Agent not found or has no URL" });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.flushHeaders();

      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      req.on("close", () => { reader?.cancel(); });

      try {
        const upstream = await fetch(`${entry.url}/ag-ui`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
        });

        if (!upstream.ok || !upstream.body) {
          res.write(`data: ${JSON.stringify({ type: "RUN_ERROR", message: `Agent HTTP ${upstream.status}` })}\n\n`);
          res.end();
          return;
        }

        reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done || !res.writable) break;
          res.write(value);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.write(`data: ${JSON.stringify({ type: "RUN_ERROR", message: msg })}\n\n`);
      }
      res.end();
    });

    // Task lifecycle events from agents
    this.app.post("/events", (req, res) => {
      const { agentId, agentName, taskId, state, skillId, timestamp, payload, clientId, clientName } = req.body as {
        agentId: string;
        agentName: string;
        taskId: string;
        state: string;
        skillId?: string;
        timestamp: string;
        payload?: unknown;
        clientId?: string;
        clientName?: string;
      };

      const event: RegistryEvent = {
        type: "task.update",
        timestamp: timestamp ?? new Date().toISOString(),
        data: { agentId, agentName, taskId, state, skillId, timestamp, payload, clientId, clientName },
      };

      this.eventBus.broadcast(event);
      res.json({ ok: true });
    });

    // Push a notification to the Claude terminal via claude/channel
    this.app.post("/notify-claude", (req, res) => {
      const { agentId, agentName, toAgentId, content, meta, conversationId, messageId, replyTo, taskId, requiresAck, expectsResponse, expiresAt } = req.body as {
        agentId?: string;
        agentName?: string;
        toAgentId?: string;
        content: string;
        meta?: Record<string, unknown>;
        conversationId?: string;
        messageId?: string;
        replyTo?: string;
        taskId?: string;
        requiresAck?: boolean;
        expectsResponse?: boolean;
        expiresAt?: number;
      };

      if (!content) {
        res.status(400).json({ error: "content is required" });
        return;
      }

      const message = this.channelStore.createMessage({
        conversationId,
        messageId,
        replyTo,
        fromAgentId: agentId ?? "unknown",
        fromAgentName: agentName,
        taskId,
        toAgentId: toAgentId ?? "claude",
        kind: "chat",
        content,
        meta,
        expiresAt,
        requiresAck,
        expectsResponse,
      });

      this.eventBus.broadcast({
        type: "channel.message",
        timestamp: new Date().toISOString(),
        data: message,
      });

      // Backward-compatible event for older listeners
      this.eventBus.broadcast({
        type: "claude.notify",
        timestamp: new Date().toISOString(),
        data: { agentId, agentName, content, meta, conversationId: message.conversationId, messageId: message.messageId },
      });

      res.json({ ok: true, conversationId: message.conversationId, messageId: message.messageId });
    });

    this.app.post("/channel/messages", (req, res) => {
      const body = req.body as Partial<ChannelMessage>;

      if (!body.content || !body.fromAgentId || !body.kind) {
        res.status(400).json({ error: "fromAgentId, kind and content are required" });
        return;
      }

      const revived = body.conversationId
        ? this.channelStore.reviveConversation(body.conversationId)
        : false;
      const message = this.channelStore.createMessage({
        conversationId: body.conversationId,
        messageId: body.messageId,
        replyTo: body.replyTo,
        fromAgentId: body.fromAgentId,
        fromAgentName: body.fromAgentName,
        toAgentId: body.toAgentId,
        taskId: body.taskId,
        kind: body.kind,
        content: body.content,
        meta: body.meta,
        createdAt: body.createdAt,
        expiresAt: body.expiresAt,
        attemptCount: body.attemptCount,
        requiresAck: body.requiresAck,
        expectsResponse: body.expectsResponse,
      });

      this.eventBus.broadcast({
        type: "channel.message",
        timestamp: new Date().toISOString(),
        data: message,
      });

      if (revived) {
        this.eventBus.broadcast({
          type: "channel.conversation.revived",
          timestamp: new Date().toISOString(),
          data: { conversationId: message.conversationId },
        });
      }

      res.status(201).json(message);
    });

    this.app.post("/channel/acks", (req, res) => {
      const body = req.body as ChannelAck;
      if (!body.conversationId || !body.messageId || !body.state || !body.actorId || !body.actorType) {
        res.status(400).json({ error: "conversationId, messageId, state, actorId and actorType are required" });
        return;
      }

      const ack = this.channelStore.addAck({
        ...body,
        timestamp: body.timestamp ?? Date.now(),
      });

      this.eventBus.broadcast({
        type: "channel.ack",
        timestamp: new Date().toISOString(),
        data: ack,
      });

      res.status(201).json(ack);
    });

    this.app.get("/channel/conversations/:id", (req, res) => {
      const snapshot = this.channelStore.getConversation(req.params.id);
      if (!snapshot) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.json(snapshot);
    });

    this.app.get("/channel/conversations", (req, res) => {
      const pendingOnly = req.query.pending === "true";
      res.json(this.channelStore.listConversations({ pendingOnly }));
    });

    this.app.post("/channel/conversations/:id/suppress", (req, res) => {
      const suppressed = this.channelStore.suppressConversation(req.params.id);
      if (!suppressed) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      this.eventBus.broadcast({
        type: "channel.conversation.suppressed",
        timestamp: new Date().toISOString(),
        data: { conversationId: req.params.id },
      });

      res.json({ suppressed: true });
    });

    this.app.delete("/channel/conversations/:id/suppress", (req, res) => {
      const revived = this.channelStore.reviveConversation(req.params.id);
      this.eventBus.broadcast({
        type: "channel.conversation.revived",
        timestamp: new Date().toISOString(),
        data: { conversationId: req.params.id },
      });
      res.json({ revived });
    });

    this.app.post("/channel/messages/:conversationId/:messageId/retry", (req, res) => {
      const retried = this.channelStore.retryMessage(req.params.conversationId, req.params.messageId);
      if (!retried) {
        res.status(404).json({ error: "Message not found" });
        return;
      }

      this.eventBus.broadcast({
        type: "channel.message",
        timestamp: new Date().toISOString(),
        data: retried,
      });

      this.eventBus.broadcast({
        type: "channel.ack",
        timestamp: new Date().toISOString(),
        data: this.channelStore.addAck({
          conversationId: retried.conversationId,
          messageId: retried.messageId,
          state: "queued",
          actorId: "registry",
          actorType: "registry",
          timestamp: Date.now(),
          detail: `Retry attempt ${retried.attemptCount ?? 1}`,
        }),
      });

      res.json(retried);
    });

    // Send message to a specific agent via registry relay
    this.app.post("/agents/:id/message", (req, res) => {
      const targetId = req.params.id;
      const message = req.body as AgentMessage;

      // Try to find agent by ID or name
      const entry = this.store.get(targetId) ??
        this.store.list().find((a) => a.name.toLowerCase() === targetId.toLowerCase());

      if (!entry) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const resolvedId = entry.agentId;
      const targetWs = this.agentWsMap.get(resolvedId);

      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
          type: "agent.message",
          timestamp: new Date().toISOString(),
          data: message,
        }));
        // Broadcast to dashboard subscribers too
        this.eventBus.broadcast({
          type: "agent.message",
          timestamp: new Date().toISOString(),
          data: message,
        });
        res.json({ ok: true, delivered: true, via: "websocket" });
      } else {
        // No WS — broadcast event, caller should fallback to HTTP direct
        this.eventBus.broadcast({
          type: "agent.message",
          timestamp: new Date().toISOString(),
          data: message,
        });
        res.json({ ok: true, delivered: false, via: "event-only" });
      }
    });
  }

  async start(): Promise<void> {
    this.httpServer = createServer(this.app);

    // WebSocket server on /ws path
    const wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });

    // WebSocket keepalive: ping every 25s, terminate if no pong within 10s
    const wsPingInterval = setInterval(() => {
      for (const client of wss.clients) {
        if ((client as any)._isAlive === false) {
          client.terminate();
          return;
        }
        (client as any)._isAlive = false;
        client.ping();
      }
    }, 25_000);

    wss.on("close", () => clearInterval(wsPingInterval));

    wss.on("connection", (ws) => {
      (ws as any)._isAlive = true;
      ws.on("pong", () => { (ws as any)._isAlive = true; });
      this.wsClients.add(ws);
      let identifiedAgentId: string | null = null;

      // Send snapshot of current agents
      ws.send(
        JSON.stringify({ type: "snapshot", agents: this.store.list() })
      );

      // Subscribe to EventBus and forward events
      const onEvent = (event: RegistryEvent) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      };
      this.eventBus.on("event", onEvent);

      // Handle incoming messages from agents
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // Agent identification — agent sends { type: "identify", agentId: "..." }
          if (msg.type === "identify" && msg.agentId) {
            // Same agent re-identifying on the same socket — just ack, no re-mapping
            if (identifiedAgentId === msg.agentId && this.agentWsMap.get(msg.agentId) === ws) {
              ws.send(JSON.stringify({ type: "identified", agentId: msg.agentId }));
              return;
            }

            if (identifiedAgentId && identifiedAgentId !== msg.agentId) {
              const previousWs = this.agentWsMap.get(identifiedAgentId);
              if (previousWs === ws) {
                this.agentWsMap.delete(identifiedAgentId);
              }
            }

            const existingWs = this.agentWsMap.get(msg.agentId);
            if (existingWs && existingWs !== ws) {
              this.agentWsMap.delete(msg.agentId);
              try {
                existingWs.close(4001, "Superseded by a newer registry connection");
              } catch {
                existingWs.terminate();
              }
            }

            identifiedAgentId = msg.agentId;
            this.agentWsMap.set(msg.agentId, ws);
            console.error(`[Registry WS] Agent identified: ${msg.agentId}`);
            ws.send(JSON.stringify({ type: "identified", agentId: msg.agentId }));
            return;
          }

          // Agent-to-agent message relay
          if (msg.type === "agent.message" && msg.data?.toAgentId) {
            const targetWs = this.agentWsMap.get(msg.data.toAgentId);
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(JSON.stringify(msg));
            }
            // Broadcast to dashboard too
            this.eventBus.broadcast({
              type: "agent.message",
              timestamp: new Date().toISOString(),
              data: msg.data,
            });
          }
        } catch {
          // Ignore parse errors from non-JSON messages
        }
      });

      ws.on("close", () => {
        this.wsClients.delete(ws);
        this.eventBus.off("event", onEvent);
        if (identifiedAgentId) {
          const mappedWs = this.agentWsMap.get(identifiedAgentId);
          if (mappedWs === ws) {
            this.agentWsMap.delete(identifiedAgentId);
            console.error(`[Registry WS] Agent disconnected: ${identifiedAgentId}`);
          }
        }
      });

      ws.on("error", (err) => {
        console.error(`[Registry WS] Error: ${err.message}`);
        this.wsClients.delete(ws);
        this.eventBus.off("event", onEvent);
        if (identifiedAgentId) {
          const mappedWs = this.agentWsMap.get(identifiedAgentId);
          if (mappedWs === ws) {
            this.agentWsMap.delete(identifiedAgentId);
          }
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, "localhost", () => resolve());
    });

    this.healthCheckTimer = setInterval(() => {
      this.store.healthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);

    console.error(`[Registry] Listening on http://localhost:${this.port}`);
    console.error(`[Registry] Dashboard: http://localhost:${this.port}/dashboard`);
  }

  async stop(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // Close all WS clients
    for (const ws of this.wsClients) {
      ws.terminate();
    }
    this.wsClients.clear();

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
