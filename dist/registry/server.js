// Registry HTTP server — central discovery service on :4999
import express from "express";
import { AgentStore } from "./store.js";
const REGISTRY_PORT = 4999;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
export class RegistryServer {
    port;
    store = new AgentStore();
    app = express();
    server = null;
    healthCheckTimer = null;
    constructor(port = REGISTRY_PORT) {
        this.port = port;
        this.setupRoutes();
    }
    setupRoutes() {
        this.app.use(express.json());
        // Register an agent
        this.app.post("/agents", (req, res) => {
            const registration = req.body;
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
            const filter = {
                skill: req.query.skill,
                project: req.query.project,
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
    async start() {
        await new Promise((resolve) => {
            this.server = this.app.listen(this.port, "localhost", () => resolve());
        });
        this.healthCheckTimer = setInterval(() => {
            this.store.healthCheck();
        }, HEALTH_CHECK_INTERVAL_MS);
        console.error(`[Registry] Listening on http://localhost:${this.port}`);
    }
    async stop() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }
        await new Promise((resolve, reject) => {
            this.server?.close((err) => (err ? reject(err) : resolve()));
        });
    }
}
//# sourceMappingURL=server.js.map