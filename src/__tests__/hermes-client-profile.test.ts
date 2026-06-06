import { describe, expect, it } from "vitest";
import { DefaultClientProfileResolver } from "../client/client-profile-resolver.js";
import { HermesClientProfile } from "../client/profiles/hermes-client-profile.js";
import { getPeerType, getPeerTypeLabel } from "../mcp/adapter.js";
import type { ChannelMessage, RegistryEntry } from "../types/messages.js";

const INNER = "client-hermes-mcp-client-bbbb";
const BRIDGE = "client-hermes-bridge-bbbb";

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

describe("HermesClientProfile", () => {
  const profile = new HermesClientProfile();

  it("is identified as 'hermes' and is inbox-first", () => {
    expect(profile.id).toBe("hermes");
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
    expect(JSON.stringify(envelope?.params)).toContain("channel_inbox");
  });
});

describe("DefaultClientProfileResolver — hermes", () => {
  const resolver = new DefaultClientProfileResolver();

  it("resolves 'hermes' and 'hermes-agent' to the Hermes profile", () => {
    expect(resolver.resolve({ clientName: "hermes" }).id).toBe("hermes");
    expect(resolver.resolve({ clientName: "hermes-agent" }).id).toBe("hermes");
    expect(resolver.resolve({ clientName: "Hermes Agent" }).id).toBe("hermes");
  });
});

describe("getPeerType / getPeerTypeLabel — hermes", () => {
  function makeEntry(clientName: string): RegistryEntry {
    return {
      agentId: "client-hermes-aaaa",
      clientInfo: { clientName, clientVersion: "0.15.0" },
    } as unknown as RegistryEntry;
  }

  it("classifies hermes client sessions as hermes-inner", () => {
    expect(getPeerType(makeEntry("hermes"))).toBe("hermes-inner");
    expect(getPeerType(makeEntry("hermes-agent"))).toBe("hermes-inner");
  });

  it("labels hermes sessions as 'Hermes inner'", () => {
    expect(getPeerTypeLabel(makeEntry("hermes"))).toBe("Hermes inner");
  });
});
