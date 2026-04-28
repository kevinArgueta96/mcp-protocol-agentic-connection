import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CurrentGeminiSessionRecord {
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
  return join(projectPath, ".open-agent-bridge", "current-gemini-session.json");
}

export function writeCurrentGeminiSession(projectPath: string, record: CurrentGeminiSessionRecord): void {
  const path = sessionFilePath(projectPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
}

export function readCurrentGeminiSession(projectPath: string): CurrentGeminiSessionRecord | undefined {
  const path = sessionFilePath(projectPath);
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as CurrentGeminiSessionRecord;
  } catch {
    return undefined;
  }
}

export function clearCurrentGeminiSession(projectPath: string, clientAgentId?: string): void {
  const path = sessionFilePath(projectPath);
  if (!existsSync(path)) return;

  if (!clientAgentId) {
    rmSync(path, { force: true });
    return;
  }

  const current = readCurrentGeminiSession(projectPath);
  if (current?.clientAgentId === clientAgentId) {
    rmSync(path, { force: true });
  }
}
