import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One line of Antigravity CLI's prompt history (`history.jsonl`).
 * `conversationId` is absent on some lines (e.g. before a conversation is
 * persisted), so it is optional.
 */
export interface AntigravityHistoryEntry {
  display: string;
  timestamp: number;
  workspace: string;
  conversationId?: string;
}

/** Default path to Antigravity CLI's history file. */
export function defaultHistoryPath(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "history.jsonl");
}

/**
 * Parse `history.jsonl`. Blank and unparseable lines are skipped silently so a
 * single corrupt line never breaks the whole read.
 */
export function parseAntigravityHistory(historyPath: string): AntigravityHistoryEntry[] {
  if (!existsSync(historyPath)) return [];

  const entries: AntigravityHistoryEntry[] = [];
  for (const line of readFileSync(historyPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AntigravityHistoryEntry;
      if (typeof parsed.workspace === "string" && typeof parsed.timestamp === "number") {
        entries.push(parsed);
      }
    } catch {
      // skip corrupt line
    }
  }
  return entries;
}

/**
 * Resolve the most-recent `conversationId` for a workspace, ignoring entries
 * that lack one. Returns undefined when the workspace has no usable entry.
 */
export function resolveConversationIdForWorkspace(
  historyPath: string,
  workspace: string,
): string | undefined {
  let best: AntigravityHistoryEntry | undefined;
  for (const entry of parseAntigravityHistory(historyPath)) {
    if (entry.workspace !== workspace || !entry.conversationId) continue;
    if (!best || entry.timestamp > best.timestamp) best = entry;
  }
  return best?.conversationId;
}
