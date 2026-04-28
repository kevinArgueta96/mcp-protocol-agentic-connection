import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CurrentCodexSessionRecord {
  clientAgentId: string;
  clientName: string;
  projectPath: string;
  registeredAt: number;
  sidecarPid?: number;
  tmuxPane?: string;
  tmuxSessionName?: string;
  tmuxWindowName?: string;
  tmuxCurrentCommand?: string;
}

function sessionFilePath(projectPath: string): string {
  return join(projectPath, ".open-agent-bridge", "current-codex-session.json");
}

export function writeCurrentCodexSession(projectPath: string, record: CurrentCodexSessionRecord): void {
  const path = sessionFilePath(projectPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
}

export function readCurrentCodexSession(projectPath: string): CurrentCodexSessionRecord | undefined {
  const path = sessionFilePath(projectPath);
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as CurrentCodexSessionRecord;
  } catch {
    return undefined;
  }
}

export function clearCurrentCodexSession(projectPath: string, clientAgentId?: string): void {
  const path = sessionFilePath(projectPath);
  if (!existsSync(path)) return;

  if (!clientAgentId) {
    rmSync(path, { force: true });
    return;
  }

  const current = readCurrentCodexSession(projectPath);
  if (current?.clientAgentId === clientAgentId) {
    rmSync(path, { force: true });
  }
}
