import { describe, expect, it } from "vitest";
import { DefaultClientProfileResolver } from "../client/client-profile-resolver.js";
import { AntigravityClientProfile } from "../client/profiles/antigravity-client-profile.js";
import type { ChannelMessage } from "../types/messages.js";

const INNER = "client-antigravity-mcp-client-bbbb";
const BRIDGE = "client-antigravity-bridge-bbbb";

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

describe("AntigravityClientProfile", () => {
  const profile = new AntigravityClientProfile();

  it("is identified as 'antigravity' and is inbox-first", () => {
    expect(profile.id).toBe("antigravity");
    expect(profile.deliveryMode).toBe("inbox-first");
  });

  it("accepts broadcast and self-addressed messages", () => {
    expect(profile.acceptsChannelMessage(makeMessage(undefined), INNER)).toBe(true);
    expect(profile.acceptsChannelMessage(makeMessage(INNER), INNER)).toBe(true);
  });

  it("regression guard: without ctx, rejects messages addressed to the sibling bridge", () => {
    expect(profile.acceptsChannelMessage(makeMessage(BRIDGE), INNER)).toBe(false);
  });

  it("with ctx.siblingBridgeAgentIds, accepts messages addressed to the sibling bridge", () => {
    expect(
      profile.acceptsChannelMessage(makeMessage(BRIDGE), INNER, {
        siblingBridgeAgentIds: new Set([BRIDGE]),
      }),
    ).toBe(true);
  });

  it("maps a channel message into an MCP notification carrying the content", () => {
    const envelope = profile.mapChannelMessage(makeMessage(undefined));
    expect(envelope?.method).toBe("notifications/message");
    expect(JSON.stringify(envelope?.params)).toContain("hi");
  });
});

describe("DefaultClientProfileResolver — antigravity", () => {
  const resolver = new DefaultClientProfileResolver();

  it("resolves 'antigravity' and 'agy' to the Antigravity profile", () => {
    expect(resolver.resolve({ clientName: "antigravity" }).id).toBe("antigravity");
    expect(resolver.resolve({ clientName: "agy" }).id).toBe("antigravity");
  });
});
