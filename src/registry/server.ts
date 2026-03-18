// Registry HTTP server — central discovery service on :4999
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { AgentStore } from "./store.js";
import { RegistryEventBus } from "./events.js";
import type { RegistryEvent } from "./events.js";
import type { AgentRegistration, AgentListFilter } from "../types/messages.js";

const REGISTRY_PORT = 4999;
const HEALTH_CHECK_INTERVAL_MS = 60_000;

const dashboardDir = new URL("../../dashboard/dist", import.meta.url).pathname;

export class RegistryServer {
  private eventBus = new RegistryEventBus();
  private store = new AgentStore(this.eventBus);
  private app = express();
  private httpServer: ReturnType<typeof createServer> | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private wsClients = new Set<WebSocket>();

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
          "Dashboard not built. Run: npm run build:dashboard"
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
        timestamp: new Date().toISOString(),
      });
    });

    // Task lifecycle events from agents
    this.app.post("/events", (req, res) => {
      const { agentId, agentName, taskId, state, skillId, timestamp, payload } = req.body as {
        agentId: string;
        agentName: string;
        taskId: string;
        state: string;
        skillId?: string;
        timestamp: string;
        payload?: unknown;
      };

      const event: RegistryEvent = {
        type: "task.update",
        timestamp: timestamp ?? new Date().toISOString(),
        data: { agentId, agentName, taskId, state, skillId, timestamp, payload },
      };

      this.eventBus.broadcast(event);
      res.json({ ok: true });
    });
  }

  async start(): Promise<void> {
    this.httpServer = createServer(this.app);

    // WebSocket server on /ws path
    const wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });

    wss.on("connection", (ws) => {
      this.wsClients.add(ws);

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

      ws.on("close", () => {
        this.wsClients.delete(ws);
        this.eventBus.off("event", onEvent);
      });

      ws.on("error", (err) => {
        console.error(`[Registry WS] Error: ${err.message}`);
        this.wsClients.delete(ws);
        this.eventBus.off("event", onEvent);
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
