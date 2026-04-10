import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import {
  readCurrentCodexSession,
  writeCurrentCodexSession,
} from "../client/codex-session-files.js";
import {
  readCurrentGeminiSession,
  writeCurrentGeminiSession,
} from "../client/gemini-session-files.js";

export type SidecarType = "codex" | "gemini";

interface SidecarConfig {
  registryUrl: string;
  pollIntervalMs: number;
  retryIntervalMs: number;
}

export interface SidecarManagerOptions {
  codexSidecar?: boolean;
  geminiSidecar?: boolean;
  codex: SidecarConfig;
  gemini: SidecarConfig;
}

/**
 * Manages detached sidecar processes for Codex and Gemini CLI clients.
 * Replaces the duplicated start/stop/build-launch methods in McpAgentBridge.
 */
export class SidecarManager {
  private processes = new Map<SidecarType, ChildProcess>();

  constructor(private readonly options: SidecarManagerOptions) {}

  startIfNeeded(
    type: SidecarType,
    projectPath: string,
    clientName: string,
    clientAgentId: string,
  ): void {
    const enabled = type === "codex" ? this.options.codexSidecar : this.options.geminiSidecar;
    if (!enabled) return;
    if (!clientName.toLowerCase().includes(type)) return;
    if (this.processes.has(type)) return;

    const launch = this.buildLaunch(type, projectPath);
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      cwd: projectPath,
      env: process.env,
    });
    child.unref();
    this.processes.set(type, child);

    this.writeSession(type, projectPath, clientAgentId, clientName, child.pid);
    console.error(`[MCP] Detached ${type} sidecar started for ${clientAgentId} (pid=${child.pid ?? "unknown"})`);
  }

  stop(type: SidecarType): void {
    const child = this.processes.get(type);
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore — process may have already exited
    }
    this.processes.delete(type);
  }

  stopAll(): void {
    this.stop("codex");
    this.stop("gemini");
  }

  isRunning(type: SidecarType): boolean {
    return this.processes.has(type);
  }

  private buildLaunch(type: SidecarType, projectPath: string): { command: string; args: string[] } {
    const cfg = type === "codex" ? this.options.codex : this.options.gemini;
    const baseArgs = [
      type,
      "tmux-sidecar",
      "--project",
      projectPath,
      "--registry-url",
      cfg.registryUrl,
      "--poll-interval-ms",
      String(cfg.pollIntervalMs),
      "--retry-interval-ms",
      String(cfg.retryIntervalMs),
    ];

    const tmuxPane = process.env["TMUX_PANE"];
    if (tmuxPane) {
      baseArgs.push("--tmux-pane", tmuxPane);
    }

    const entry = process.argv[1] ?? "";
    if (entry.endsWith(".ts")) {
      return { command: "pnpm", args: ["exec", "tsx", resolve(entry), ...baseArgs] };
    }
    return { command: process.execPath, args: [resolve(entry), ...baseArgs] };
  }

  private writeSession(
    type: SidecarType,
    projectPath: string,
    clientAgentId: string,
    clientName: string,
    pid: number | undefined,
  ): void {
    const base = {
      clientAgentId,
      clientName,
      projectPath,
      registeredAt: Date.now(),
      sidecarPid: pid,
      tmuxPane: process.env["TMUX_PANE"],
    } as const;

    if (type === "codex") {
      const existing = readCurrentCodexSession(projectPath);
      writeCurrentCodexSession(projectPath, {
        ...base,
        tmuxPane: existing?.tmuxPane ?? process.env["TMUX_PANE"],
        tmuxSessionName: existing?.tmuxSessionName,
        tmuxWindowName: existing?.tmuxWindowName,
        tmuxCurrentCommand: existing?.tmuxCurrentCommand,
      });
    } else {
      const existing = readCurrentGeminiSession(projectPath);
      writeCurrentGeminiSession(projectPath, {
        ...base,
        tmuxPane: existing?.tmuxPane ?? process.env["TMUX_PANE"],
        tmuxSessionName: existing?.tmuxSessionName,
        tmuxWindowName: existing?.tmuxWindowName,
        tmuxCurrentCommand: existing?.tmuxCurrentCommand,
      });
    }
  }
}
