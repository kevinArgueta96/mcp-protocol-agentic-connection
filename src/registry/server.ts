// Registry HTTP server — central discovery service on :4999
import express from "express";
import { AgentStore } from "./store.js";
import type { AgentRegistration, AgentListFilter } from "../types/messages.js";

const REGISTRY_PORT = 4999;
const HEALTH_CHECK_INTERVAL_MS = 60_000;

export class RegistryServer {
  private store = new AgentStore();
  private app = express();
  private server: ReturnType<typeof this.app.listen> | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(private readonly port = REGISTRY_PORT) {
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

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
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server = this.app.listen(this.port, "localhost", () => resolve());
    });

    this.healthCheckTimer = setInterval(() => {
      this.store.healthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);

    console.error(`[Registry] Listening on http://localhost:${this.port}`);
  }

  async stop(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
