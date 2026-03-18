// AgentServer: A2A-compliant HTTP + WebSocket server per project/terminal
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { detectProjectType } from "./project-detector.js";
import { generateAgentCard } from "./card.js";
import { TaskStore, RequestRouter } from "./handlers.js";
import { createDefaultRegistry } from "../skills/index.js";
const REGISTRY_URL = "http://localhost:4999";
const HEARTBEAT_INTERVAL_MS = 30_000;
const BASE_PORT = 5001;
const MAX_PORT = 5099;
export class AgentServer {
    options;
    agentId;
    card = null;
    taskStore = new TaskStore();
    router = new RequestRouter();
    heartbeatTimer = null;
    httpServer = null;
    routerCtx = null;
    constructor(options = {}) {
        this.options = options;
        this.agentId = randomUUID();
    }
    async start() {
        const projectPath = resolve(this.options.projectPath ?? process.cwd());
        const projectInfo = await detectProjectType(projectPath);
        const skillRegistry = createDefaultRegistry();
        for (const skill of this.options.extraSkills ?? []) {
            skillRegistry.register(skill);
        }
        const port = await this.findAvailablePort(this.options.port ?? BASE_PORT);
        this.card = generateAgentCard({
            agentId: this.agentId,
            port,
            projectInfo,
            skills: skillRegistry.toAgentSkills(),
        });
        this.routerCtx = {
            agentId: this.agentId,
            projectPath,
            projectName: projectInfo.name,
            projectType: projectInfo.type,
            taskStore: this.taskStore,
            skillRegistry,
        };
        const app = express();
        app.use(express.json());
        // ── A2A: Agent Card ──────────────────────────────────────────────────────
        app.get("/.well-known/agent.json", (_req, res) => {
            res.json(this.card);
        });
        // ── A2A: JSON-RPC endpoint ───────────────────────────────────────────────
        app.post("/", async (req, res) => {
            const rpcReq = req.body;
            const response = await this.router.dispatch(rpcReq, this.routerCtx);
            res.json(response);
        });
        // ── Health check ─────────────────────────────────────────────────────────
        app.get("/health", (_req, res) => {
            res.json({
                ok: true,
                agentId: this.agentId,
                projectName: projectInfo.name,
                projectPath,
                port,
                timestamp: new Date().toISOString(),
            });
        });
        // ── Create HTTP server + WebSocket ───────────────────────────────────────
        this.httpServer = createServer(app);
        const wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });
        wss.on("connection", (ws) => this.handleWsConnection(ws));
        await new Promise((resolve) => {
            this.httpServer.listen(port, "localhost", () => resolve());
        });
        // ── Register with registry ───────────────────────────────────────────────
        await this.registerWithRegistry(port, projectPath, projectInfo.name, projectInfo.type);
        // ── Start heartbeat ──────────────────────────────────────────────────────
        this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
        return {
            agentId: this.agentId,
            port,
            url: `http://localhost:${port}`,
            wsUrl: `ws://localhost:${port}/ws`,
            card: this.card,
        };
    }
    async stop() {
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        await this.sendHeartbeat("shutting-down");
        await this.deregisterFromRegistry();
        await new Promise((resolve, reject) => {
            this.httpServer?.close((err) => (err ? reject(err) : resolve()));
        });
    }
    // ── WebSocket handler ──────────────────────────────────────────────────────
    handleWsConnection(ws) {
        // Send agent.hello on connect
        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            method: "agent.hello",
            params: {
                agentId: this.agentId,
                projectName: this.routerCtx?.projectName,
                projectPath: this.routerCtx?.projectPath,
                card: this.card,
                timestamp: new Date().toISOString(),
            },
        }));
        ws.on("message", async (raw) => {
            try {
                const rpcReq = JSON.parse(raw.toString());
                const response = await this.router.dispatch(rpcReq, this.routerCtx);
                ws.send(JSON.stringify(response));
            }
            catch {
                ws.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
            }
        });
        ws.on("error", (err) => console.error(`[WS] Error: ${err.message}`));
    }
    // ── Port discovery ─────────────────────────────────────────────────────────
    async findAvailablePort(startPort) {
        for (let port = startPort; port <= MAX_PORT; port++) {
            if (await this.isPortFree(port))
                return port;
        }
        // Fall back to OS-assigned port
        return 0;
    }
    isPortFree(port) {
        return new Promise((resolve) => {
            const server = createServer();
            server.once("error", () => resolve(false));
            server.once("listening", () => {
                server.close(() => resolve(true));
            });
            server.listen(port, "localhost");
        });
    }
    // ── Registry integration ───────────────────────────────────────────────────
    async registerWithRegistry(port, projectPath, projectName, projectType) {
        const registryUrl = this.options.registryUrl ?? REGISTRY_URL;
        try {
            const res = await fetch(`${registryUrl}/agents`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    agentId: this.agentId,
                    name: projectName,
                    url: `http://localhost:${port}`,
                    wsUrl: `ws://localhost:${port}/ws`,
                    port,
                    projectPath,
                    projectName,
                    projectType,
                    card: this.card,
                    registeredAt: Date.now(),
                }),
            });
            if (!res.ok)
                console.error(`[Agent] Registry registration failed: ${res.status}`);
        }
        catch {
            console.error("[Agent] Registry not available — running standalone");
        }
    }
    async sendHeartbeat(status = "alive") {
        const registryUrl = this.options.registryUrl ?? REGISTRY_URL;
        try {
            await fetch(`${registryUrl}/agents/${this.agentId}/heartbeat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ agentId: this.agentId, timestamp: Date.now(), status }),
            });
        }
        catch {
            // Registry down — silently continue
        }
    }
    async deregisterFromRegistry() {
        const registryUrl = this.options.registryUrl ?? REGISTRY_URL;
        try {
            await fetch(`${registryUrl}/agents/${this.agentId}`, { method: "DELETE" });
        }
        catch {
            // Ignore
        }
    }
}
//# sourceMappingURL=server.js.map