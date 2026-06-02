import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendOriginalRequest,
  originalRequestPath,
} from "../client/antigravity-agents-file.js";

/**
 * Antigravity's native multi-agent coordination passes parent→child messages by
 * appending to `.agents/ORIGINAL_REQUEST.md` with a UTC timestamp header. The
 * bridge delivers an inbound channel message by writing it there; the agent
 * picks it up as a "new message from parent agent" on its next turn.
 *
 * The writer must be idempotent: a retried delivery of the same channel
 * messageId must NOT append a duplicate block.
 */

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "agy-agents-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const baseEntry = {
  messageId: "msg-1",
  fromAgentId: "client-claude-zzzz",
  fromAgentName: "claude",
  conversationId: "conv-1",
  content: "Please review the PR.",
  timestampIso: "2026-06-02T15:00:00Z",
};

describe("appendOriginalRequest", () => {
  it("creates .agents/ORIGINAL_REQUEST.md with a UTC timestamp header and the content", () => {
    const result = appendOriginalRequest(workspace, baseEntry);

    expect(result.appended).toBe(true);
    expect(result.path).toBe(originalRequestPath(workspace));
    expect(existsSync(result.path)).toBe(true);

    const text = readFileSync(result.path, "utf8");
    expect(text).toContain("## 2026-06-02T15:00:00Z");
    expect(text).toContain("Please review the PR.");
    expect(text).toContain("claude");
  });

  it("appends a second distinct message below the first", () => {
    appendOriginalRequest(workspace, baseEntry);
    const second = appendOriginalRequest(workspace, {
      ...baseEntry,
      messageId: "msg-2",
      content: "Second message.",
      timestampIso: "2026-06-02T15:05:00Z",
    });

    expect(second.appended).toBe(true);
    const text = readFileSync(second.path, "utf8");
    expect(text).toContain("Please review the PR.");
    expect(text).toContain("Second message.");
    expect(text.indexOf("Please review the PR.")).toBeLessThan(text.indexOf("Second message."));
  });

  it("is idempotent: re-delivering the same messageId does not append a duplicate", () => {
    appendOriginalRequest(workspace, baseEntry);
    const dup = appendOriginalRequest(workspace, { ...baseEntry, content: "different text" });

    expect(dup.appended).toBe(false);
    const occurrences = readFileSync(dup.path, "utf8").split("msg-1").length - 1;
    expect(occurrences).toBe(1);
  });
});
