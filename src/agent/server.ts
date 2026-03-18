// AgentServer: A2A-compliant HTTP + WebSocket server per project/terminal
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentCard } from "../types/a2a.js";
import type { JsonRpcRequest } from "../types/jsonrpc.js";
import { detectProjectType } from "./project-detector.js";
import { generateAgentCard } from "./card.js";
import { TaskStore, RequestRouter } from "./handlers.js";
import type { RouterContext, TaskUpdateEvent } from "./handlers.js";
import { createDefaultRegistry } from "../skills/index.js";
import type { BaseSkill } from "../skills/framework.js";

const REGISTRY_URL = "http://localhost:4999";
const HEARTBEAT_INTERVAL_MS = 30_000;
const BASE_PORT = 5001;
const MAX_PORT = 5099;

export interface AgentServerOptions {
  port?: number;
  projectPath?: string;
  extraSkills?: BaseSkill[];
  registryUrl?: string;
  name?: string;
}

export interface StartResult {
  agentId: string;
  port: number;
  url: string;
  wsUrl: string;
  card: AgentCard;
}

export class AgentServer {
  private agentId: string;
  private card: AgentCard | null = null;
  private taskStore: TaskStore | null = null;
  private router = new RequestRouter();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private routerCtx: RouterContext | null = null;

  constructor(private readonly options: AgentServerOptions = {}) {
    this.agentId = randomUUID();
  }

  async start(): Promise<StartResult> {
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

    const registryUrl = this.options.registryUrl ?? REGISTRY_URL;

    const postTaskUpdate = (event: TaskUpdateEvent): void => {
      fetch(`${registryUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: event.agentId,
          agentName: projectInfo.name,
          taskId: event.taskId,
          state: event.state,
          skillId: event.skillId,
          timestamp: event.timestamp,
          payload: event.payload,
        }),
      }).catch(() => {
        // Registry down — silently continue
      });
    };

    this.taskStore = new TaskStore(this.agentId, postTaskUpdate);

    this.routerCtx = {
      agentId: this.agentId,
      projectPath,
      projectName: projectInfo.name,
      projectType: projectInfo.type,
      taskStore: this.taskStore,
      skillRegistry,
      registryUrl,
    };

    const app = express();
    app.use(express.json());

    // ── CORS for dashboard browser access ────────────────────────────────────
    app.use((_req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      next();
    });
    app.options("/{*path}", (_req, res) => { res.sendStatus(204); });

    // ── A2A: Agent Card ──────────────────────────────────────────────────────
    app.get("/.well-known/agent.json", (_req, res) => {
      res.json(this.card);
    });

    // ── A2A: JSON-RPC endpoint ───────────────────────────────────────────────
    app.post("/", async (req, res) => {
      const rpcReq = req.body as JsonRpcRequest;
      const response = await this.router.dispatch(rpcReq, this.routerCtx!);
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

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, "localhost", () => resolve());
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

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.sendHeartbeat("shutting-down");
    await this.deregisterFromRegistry();
    await new Promise<void>((resolve, reject) => {
      this.httpServer?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // ── WebSocket handler ──────────────────────────────────────────────────────
  private handleWsConnection(ws: WebSocket): void {
    // Send agent.hello on connect
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "agent.hello",
        params: {
          agentId: this.agentId,
          projectName: this.routerCtx?.projectName,
          projectPath: this.routerCtx?.projectPath,
          card: this.card,
          timestamp: new Date().toISOString(),
        },
      })
    );

    ws.on("message", async (raw) => {
      try {
        const rpcReq = JSON.parse(raw.toString()) as JsonRpcRequest;
        const response = await this.router.dispatch(rpcReq, this.routerCtx!);
        ws.send(JSON.stringify(response));
      } catch {
        ws.send(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
        );
      }
    });

    ws.on("error", (err) => console.error(`[WS] Error: ${err.message}`));
  }

  // ── Port discovery ─────────────────────────────────────────────────────────
  private async findAvailablePort(startPort: number): Promise<number> {
    for (let port = startPort; port <= MAX_PORT; port++) {
      if (await this.isPortFree(port)) return port;
    }
    // Fall back to OS-assigned port
    return 0;
  }

  private isPortFree(port: number): Promise<boolean> {
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
  private async registerWithRegistry(
    port: number,
    projectPath: string,
    projectName: string,
    projectType: string
  ): Promise<void> {
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
      if (!res.ok) console.error(`[Agent] Registry registration failed: ${res.status}`);
    } catch {
      console.error("[Agent] Registry not available — running standalone");
    }
  }

  private async sendHeartbeat(status: "alive" | "shutting-down" = "alive"): Promise<void> {
    const registryUrl = this.options.registryUrl ?? REGISTRY_URL;
    try {
      await fetch(`${registryUrl}/agents/${this.agentId}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: this.agentId, timestamp: Date.now(), status }),
      });
    } catch {
      // Registry down — silently continue
    }
  }

  private async deregisterFromRegistry(): Promise<void> {
    const registryUrl = this.options.registryUrl ?? REGISTRY_URL;
    try {
      await fetch(`${registryUrl}/agents/${this.agentId}`, { method: "DELETE" });
    } catch {
      // Ignore
    }
  }
}
