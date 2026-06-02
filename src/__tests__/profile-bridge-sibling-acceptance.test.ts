import { describe, expect, it } from "vitest";
import { ClaudeClientProfile } from "../client/profiles/claude-client-profile.js";
import { CodexClientProfile } from "../client/profiles/codex-client-profile.js";
import type { ChannelMessage } from "../types/messages.js";

/**
 * Regression tests for the bridge-sibling acceptance fix.
 *
 * Why this exists: Codex/Gemini sessions register two entries in the registry —
 *   1. the bridge daemon  (`client-{codex,gemini}-bridge-*`)
 *   2. the inner MCP client (`client-{codex,gemini}-mcp-client-*`)
 * The adapter auto-redirects outbound `toAgentId` to the bridge for delivery.
 * The inner client must still recognize that rewritten message as locally
 * addressable so it surfaces in `channel_inbox(pendingOnly=true)`. Without the
 * `siblingBridgeAgentIds` context the inner client used to drop the message
 * silently, leaving the agent unable to discover pending work.
 */

const CODEX_INNER = "client-codex-mcp-client-aaaa";
const CODEX_BRIDGE = "client-codex-bridge-aaaa";

function makeMessage(toAgentId: string | undefined): ChannelMessage {
  return {
    conversationId: "conv-1",
    messageId: "msg-1",
    fromAgentId: "client-claude-zzzz",
    fromAgentName: "claude",
    toAgentId,
    kind: "chat",
    content: "hi",
    createdAt: Date.now(),
  };
}

describe("CodexClientProfile.acceptsChannelMessage — sibling bridge", () => {
  const profile = new CodexClientProfile();

  it("accepts broadcast (no toAgentId) regardless of context", () => {
    expect(profile.acceptsChannelMessage(makeMessage(undefined), CODEX_INNER)).toBe(true);
    expect(
      profile.acceptsChannelMessage(makeMessage(undefined), CODEX_INNER, {
        siblingBridgeAgentIds: new Set([CODEX_BRIDGE]),
      }),
    ).toBe(true);
  });

  it("accepts a message addressed to selfAgentId", () => {
    expect(profile.acceptsChannelMessage(makeMessage(CODEX_INNER), CODEX_INNER)).toBe(true);
  });

  it("regression guard: without ctx, rejects messages addressed to the sibling bridge", () => {
    expect(profile.acceptsChannelMessage(makeMessage(CODEX_BRIDGE), CODEX_INNER)).toBe(false);
  });

  it("with ctx.siblingBridgeAgentIds, accepts messages addressed to the sibling bridge", () => {
    expect(
      profile.acceptsChannelMessage(makeMessage(CODEX_BRIDGE), CODEX_INNER, {
        siblingBridgeAgentIds: new Set([CODEX_BRIDGE]),
      }),
    ).toBe(true);
  });

  it("rejects messages addressed to a foreign agent even with ctx", () => {
    expect(
      profile.acceptsChannelMessage(makeMessage("client-other-cccc"), CODEX_INNER, {
        siblingBridgeAgentIds: new Set([CODEX_BRIDGE]),
      }),
    ).toBe(false);
  });
});

describe("ClaudeClientProfile.acceptsChannelMessage — ignores ctx", () => {
  const profile = new ClaudeClientProfile();

  it("does NOT accept messages addressed to a foreign bridge even with ctx populated", () => {
    // Defense-in-depth: Claude has no bridge daemon sibling. Even if some caller
    // accidentally passes a non-empty siblingBridgeAgentIds set, Claude must
    // never treat a message addressed to a Codex/Gemini bridge as its own.
    expect(
      profile.acceptsChannelMessage(makeMessage(CODEX_BRIDGE), "client-claude-zzzz", {
        siblingBridgeAgentIds: new Set([CODEX_BRIDGE]),
      }),
    ).toBe(false);
  });

  it("still accepts the legacy 'claude' broadcast alias", () => {
    expect(profile.acceptsChannelMessage(makeMessage("claude"), "client-claude-zzzz")).toBe(true);
  });

  it("accepts broadcast regardless of ctx", () => {
    expect(
      profile.acceptsChannelMessage(makeMessage(undefined), "client-claude-zzzz", {
        siblingBridgeAgentIds: new Set([CODEX_BRIDGE]),
      }),
    ).toBe(true);
  });
});
