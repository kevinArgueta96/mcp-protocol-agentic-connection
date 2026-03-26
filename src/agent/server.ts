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
import { TaskStore, RequestRouter, inferSkillFromMessage, parseInputFromMessage, makeSkillContext } from "./handlers.js";
import type { RouterContext, TaskUpdateEvent } from "./handlers.js";
import {
  runStarted, runFinished, runError,
  stepStarted, stepFinished,
  textMessageStart, textMessageContent, textMessageEnd,
  toolCallStart, toolCallArgs, toolCallEnd,
  sseLine,
} from "./ag-ui-events.js";
import { createDefaultRegistry, createClaudeRegistry } from "../skills/index.js";
import type { BaseSkill } from "../skills/framework.js";
import type { AgentMessage } from "../types/messages.js";
import { ClaudeProcess } from "../skills/builtins/claude-process.js";

const REGISTRY_URL = "http://localhost:4999";
const HEARTBEAT_INTERVAL_MS = 30_000;
const BASE_PORT = 5001;
const MAX_PORT = 5099;

export interface AgentServerOptions {
  port?: number;
  projectPath?: string;
  extraSkills?: BaseSkill[];
  registryUrl?: string;
  useClaudeCode?: boolean;
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
  private registryWs: WebSocket | null = null;
  private registryWsReconnectTimer: NodeJS.Timeout | null = null;
  private registryWsReconnectAttempts = 0;
  private readonly MAX_WS_RECONNECT = 5;
  private messageHandlers = new Set<(msg: AgentMessage) => void>();
  private processedTaskIds = new Set<string>();

  constructor(private readonly options: AgentServerOptions = {}) {
    this.agentId = randomUUID();
  }

  async start(): Promise<StartResult> {
    const projectPath = resolve(this.options.projectPath ?? process.cwd());
    const projectInfo = await detectProjectType(projectPath);
    const skillRegistry = this.options.useClaudeCode
      ? createClaudeRegistry(projectPath)
      : createDefaultRegistry();

    if (this.options.useClaudeCode) {
      ClaudeProcess.getInstance().start(projectPath);
    }

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
      projectInfo: {
        type: projectInfo.type,
        category: projectInfo.category,
        framework: projectInfo.framework,
      },
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
      try {
        const rpcReq = req.body as JsonRpcRequest;
        const response = await this.router.dispatch(rpcReq, this.routerCtx!);
        res.json(response);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Agent] JSON-RPC error: ${msg}`);
        res.json({ jsonrpc: "2.0", id: (req.body as { id?: unknown })?.id ?? null, error: { code: -32603, message: msg } });
      }
    });

    // ── AG-UI: SSE streaming endpoint ────────────────────────────────────────
    app.post("/ag-ui", async (req, res) => {
      const { randomUUID: uuid } = await import("node:crypto");
      const body = req.body as {
        threadId?: string;
        runId?: string;
        messages?: Array<{ id?: string; role: string; content: string }>;
      };

      const threadId = body.threadId ?? uuid();
      const runId = body.runId ?? uuid();
      const ctx = this.routerCtx!;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      let aborted = false;
      res.on("close", () => { aborted = true; });
      res.on("error", () => { aborted = true; });

      const emit = (event: unknown) => {
        if (!aborted) {
          try { res.write(sseLine(event)); } catch { aborted = true; }
        }
      };

      try {
        emit(runStarted(threadId, runId));

        // Extract user text from last user message
        const lastUserMsg = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
        const userText = lastUserMsg?.content ?? "";

        // Infer skill from text
        const fakeParams = {
          message: { role: "user" as const, parts: [{ type: "text" as const, text: userText }] },
        };
        const skillId = inferSkillFromMessage(fakeParams);

        // Resolve skill: inferred → fallback to best available skill for the text
        const availableSkills = ctx.skillRegistry.list().map((s) => s.id);
        const resolvedSkillId = (skillId && ctx.skillRegistry.get(skillId))
          ? skillId
          : availableSkills.includes("code-query")
            ? "code-query"
            : availableSkills[0] ?? "code-query";

        const skill = ctx.skillRegistry.get(resolvedSkillId);
        if (!skill) {
          emit(runError(`No skills available. Registered: ${availableSkills.join(", ") || "none"}`));
          res.end();
          return;
        }

        const taskId = uuid();
        const skillCtx = makeSkillContext(ctx.agentId, taskId, ctx.projectPath, ctx.projectInfo);

        // Build skill input: if inferred skill matches, parse from message; otherwise use full text as query
        const rawInput = (resolvedSkillId !== skillId)
          ? { query: userText }
          : parseInputFromMessage(fakeParams);

        const parsed = skill.inputSchema.safeParse(rawInput);

        const toolCallId = uuid();
        const parentMsgId = uuid();

        emit(stepStarted(resolvedSkillId));
        emit(toolCallStart(toolCallId, resolvedSkillId, parentMsgId));
        emit(toolCallArgs(toolCallId, JSON.stringify(parsed.success ? parsed.data : rawInput)));

        ctx.taskStore.create({ message: fakeParams.message, metadata: { skillId: resolvedSkillId } });

        let result: unknown;
        if (parsed.success) {
          result = await skill!.execute(parsed.data, skillCtx);
        } else {
          result = { error: `Invalid input: ${parsed.error.message}` };
        }

        if (aborted) return;

        emit(toolCallEnd(toolCallId));
        emit(stepFinished(resolvedSkillId));

        // Stream result as text message
        const msgId = uuid();
        const resultText = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        if (!resultText) {
          emit(runError("Empty result from skill"));
          res.end();
          return;
        }
        emit(textMessageStart(msgId));
        emit(textMessageContent(msgId, resultText));
        emit(textMessageEnd(msgId));

        emit(runFinished(threadId, runId));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit(runError(msg));
      }

      res.end();
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

    // ── Global Express error handler ─────────────────────────────────────────
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Agent] Unhandled error: ${msg}`);
      if (!res.headersSent) {
        res.status(500).json({ error: msg });
      }
    });

    // ── Create HTTP server + WebSocket ───────────────────────────────────────
    this.httpServer = createServer(app);
    this.httpServer.on("error", (err) => {
      console.error(`[Agent] HTTP server error: ${err.message}`);
    });

    const wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    wss.on("connection", (ws) => this.handleWsConnection(ws));
    wss.on("error", (err) => {
      console.error(`[Agent] WebSocket server error: ${err.message}`);
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, "localhost", () => resolve());
    });

    // ── Register with registry ───────────────────────────────────────────────
    await this.registerWithRegistry(port, projectPath, projectInfo.name, projectInfo.type);

    // ── Start heartbeat ──────────────────────────────────────────────────────
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);

    // ── Connect WS to registry for message relay ──────────────────────────
    this.connectToRegistry(registryUrl);

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
    if (this.registryWsReconnectTimer) clearTimeout(this.registryWsReconnectTimer);
    if (this.registryWs) {
      this.registryWs.close();
      this.registryWs = null;
    }
    ClaudeProcess.getInstance().stop();
    await this.sendHeartbeat("shutting-down");
    await this.deregisterFromRegistry();
    await new Promise<void>((resolve, reject) => {
      this.httpServer?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Subscribe to incoming messages from other agents via registry relay */
  onMessage(handler: (msg: AgentMessage) => void): void {
    this.messageHandlers.add(handler);
  }

  /** Send a message to another agent via registry WS relay */
  sendMessageViaRegistry(message: AgentMessage): boolean {
    if (this.registryWs && this.registryWs.readyState === WebSocket.OPEN) {
      this.registryWs.send(JSON.stringify({
        type: "agent.message",
        timestamp: new Date().toISOString(),
        data: message,
      }));
      return true;
    }
    return false;
  }

  // ── Registry WebSocket connection ─────────────────────────────────────────
  private connectToRegistry(registryUrl: string): void {
    const wsUrl = registryUrl.replace(/^http/, "ws") + "/ws";
    try {
      const ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        console.error(`[Agent] WebSocket connected to registry at ${wsUrl}`);
        this.registryWsReconnectAttempts = 0;
        // Identify this agent to the registry
        ws.send(JSON.stringify({ type: "identify", agentId: this.agentId }));
        this.registryWs = ws;
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "agent.message" && msg.data) {
            const agentMsg = msg.data as AgentMessage;
            // Log incoming message in terminal
            const fromId = agentMsg.fromAgentId?.slice(0, 8) ?? "unknown";
            const msgType = agentMsg.type;
            const preview = typeof agentMsg.payload === "string"
              ? agentMsg.payload.slice(0, 80)
              : JSON.stringify(agentMsg.payload).slice(0, 80);
            console.error(`[← INCOMING] ${fromId} → ${msgType}: ${preview}`);

            // If it's a task.request, process it and send response back
            if (agentMsg.type === "task.request" && this.routerCtx) {
              // Only handle messages destined for this agent (registry broadcasts to all WS clients)
              if (agentMsg.toAgentId && agentMsg.toAgentId !== this.agentId) {
                return; // Message is for a different agent — ignore
              }
              // Deduplicate: registry may deliver twice (direct + broadcast)
              if (agentMsg.taskId) {
                if (this.processedTaskIds.has(agentMsg.taskId)) return;
                this.processedTaskIds.add(agentMsg.taskId);
                setTimeout(() => this.processedTaskIds.delete(agentMsg.taskId!), 300_000);
              }
              void this.handleIncomingTask(agentMsg);
            }

            // Notify handlers
            for (const handler of this.messageHandlers) {
              try { handler(agentMsg); } catch { /* ignore handler errors */ }
            }
          }
        } catch {
          // Ignore non-JSON or unrecognized messages
        }
      });

      ws.on("close", () => {
        console.error("[Agent] Registry WS disconnected — reconnecting in 5s");
        this.registryWs = null;
        this.scheduleReconnect(registryUrl);
      });

      ws.on("error", () => {
        // Error will trigger close, which handles reconnection
        this.registryWs = null;
      });
    } catch {
      this.scheduleReconnect(registryUrl);
    }
  }

  private scheduleReconnect(registryUrl: string): void {
    if (this.registryWsReconnectTimer) return;
    if (this.registryWsReconnectAttempts >= this.MAX_WS_RECONNECT) {
      console.error(`[Agent] WS reconnect limit reached (${this.MAX_WS_RECONNECT}). WS relay disabled.`);
      return;
    }
    this.registryWsReconnectAttempts++;
    this.registryWsReconnectTimer = setTimeout(() => {
      this.registryWsReconnectTimer = null;
      this.connectToRegistry(registryUrl);
    }, 5_000);
  }

  private async handleIncomingTask(agentMsg: AgentMessage): Promise<void> {
    const ctx = this.routerCtx!;
    const startTime = Date.now();
    try {
      const payload = agentMsg.payload as { message?: string; skillId?: string; input?: Record<string, unknown> };
      const messageText = payload?.message ?? "";
      const fakeParams = {
        message: { role: "user" as const, parts: [{ type: "text" as const, text: messageText }] },
        metadata: {
          ...(payload?.skillId ? { skillId: payload.skillId } : {}),
          ...(payload?.input ? { input: payload.input } : {}),
        },
      };

      const skillId = payload?.skillId ?? inferSkillFromMessage(fakeParams);
      console.error(`[← TASK] Processing skill: ${skillId ?? "auto"} from ${agentMsg.fromAgentId.slice(0, 8)}`);

      const task = ctx.taskStore.create(fakeParams);
      const rpcReq = {
        jsonrpc: "2.0" as const,
        id: task.id,
        method: "tasks/send",
        params: {
          id: task.id,
          ...fakeParams,
        },
      };

      const response = await this.router.dispatch(rpcReq, ctx);
      const elapsed = Date.now() - startTime;
      console.error(`[→ COMPLETED] Task ${task.id.slice(0, 8)} (${elapsed}ms)`);

      // Send response back via WS
      const responseMsg: AgentMessage = {
        fromAgentId: this.agentId,
        toAgentId: agentMsg.fromAgentId,
        taskId: agentMsg.taskId,
        type: "task.response",
        payload: response,
        timestamp: Date.now(),
      };
      this.sendMessageViaRegistry(responseMsg);
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[✗ ERROR] Task failed (${elapsed}ms): ${errMsg}`);

      const errorResponse: AgentMessage = {
        fromAgentId: this.agentId,
        toAgentId: agentMsg.fromAgentId,
        taskId: agentMsg.taskId,
        type: "task.response",
        payload: { error: errMsg },
        timestamp: Date.now(),
      };
      this.sendMessageViaRegistry(errorResponse);
    }
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
          entryType: "agent",
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
