import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * An inbound channel message to surface to an Antigravity agent via its native
 * `.agents/ORIGINAL_REQUEST.md` convention.
 */
export interface OriginalRequestEntry {
  messageId: string;
  fromAgentId: string;
  fromAgentName?: string;
  conversationId?: string;
  content: string;
  /** ISO-8601 UTC timestamp for the section header (e.g. 2026-06-02T15:00:00Z). */
  timestampIso: string;
}

/** Path to the workspace's ORIGINAL_REQUEST.md. */
export function originalRequestPath(workspacePath: string): string {
  return join(workspacePath, ".agents", "ORIGINAL_REQUEST.md");
}

/**
 * Append a channel message to `.agents/ORIGINAL_REQUEST.md`, creating the file
 * and directory if needed. Idempotent by messageId: a per-message HTML comment
 * marker is embedded so a re-delivered message is skipped instead of appended
 * twice. Returns whether a new block was written.
 */
export function appendOriginalRequest(
  workspacePath: string,
  entry: OriginalRequestEntry,
): { appended: boolean; path: string } {
  const path = originalRequestPath(workspacePath);
  const marker = `<!-- oab-msg:${entry.messageId} -->`;

  if (existsSync(path) && readFileSync(path, "utf8").includes(marker)) {
    return { appended: false, path };
  }

  mkdirSync(dirname(path), { recursive: true });

  const sender = entry.fromAgentName ?? entry.fromAgentId;
  const conversation = entry.conversationId ? ` · conversation \`${entry.conversationId}\`` : "";
  const block =
    `## ${entry.timestampIso}\n` +
    `${marker}\n` +
    `New channel message from **${sender}** (\`${entry.fromAgentId}\`)${conversation}.\n\n` +
    `${entry.content}\n\n` +
    "Reply through the open-agent-bridge channel tools (`reply` / `message_client_session`).\n\n";

  if (existsSync(path)) {
    appendFileSync(path, block, "utf8");
  } else {
    writeFileSync(path, block, "utf8");
  }

  return { appended: true, path };
}
