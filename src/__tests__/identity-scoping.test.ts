import { describe, expect, it } from "vitest";
import { AntigravityClientProfile } from "../client/profiles/antigravity-client-profile.js";
import { ClaudeClientProfile } from "../client/profiles/claude-client-profile.js";
import { CodexClientProfile } from "../client/profiles/codex-client-profile.js";
import { OpenCodeClientProfile } from "../client/profiles/opencode-client-profile.js";
import type { ClientBehaviorProfile } from "../client/client-profile-resolver.js";
import type { ChannelMessage } from "../types/messages.js";

/**
 * Identity is a channel namespace. A message is only visible to a session whose
 * own identity matches the message's identity — a HARD WALL, enforced even for
 * messages addressed directly to the session's agentId. Both default to
 * "global" when omitted, so legacy/global sessions keep talking to each other.
 */

const SELF = "client-x-self";

function msg(overrides: Partial<ChannelMessage>): ChannelMessage {
  return {
    conversationId: "c1",
    messageId: "m1",
    fromAgentId: "client-other",
    kind: "chat",
    content: "hi",
    createdAt: 0,
    ...overrides,
  };
}

const profiles: Array<[string, ClientBehaviorProfile]> = [
  ["antigravity", new AntigravityClientProfile()],
  ["claude", new ClaudeClientProfile()],
  ["codex", new CodexClientProfile()],
  ["opencode", new OpenCodeClientProfile()],
];

describe.each(profiles)("%s profile — identity hard wall", (_name, profile) => {
  it("accepts a same-identity message addressed to self", () => {
    expect(
      profile.acceptsChannelMessage(msg({ toAgentId: SELF, identity: "ticket-1" }), SELF, {
        selfIdentity: "ticket-1",
      }),
    ).toBe(true);
  });

  it("REJECTS a different-identity message even when addressed to self", () => {
    expect(
      profile.acceptsChannelMessage(msg({ toAgentId: SELF, identity: "ticket-2" }), SELF, {
        selfIdentity: "ticket-1",
      }),
    ).toBe(false);
  });

  it("REJECTS a different-identity broadcast", () => {
    expect(
      profile.acceptsChannelMessage(msg({ toAgentId: undefined, identity: "ticket-2" }), SELF, {
        selfIdentity: "ticket-1",
      }),
    ).toBe(false);
  });

  it("defaults both sides to 'global' — a no-identity message reaches a no-identity session", () => {
    // No selfIdentity in ctx, no identity on message → both "global".
    expect(profile.acceptsChannelMessage(msg({ toAgentId: SELF }), SELF)).toBe(true);
  });

  it("a global session does NOT see a ticket-scoped message addressed to it", () => {
    expect(
      profile.acceptsChannelMessage(msg({ toAgentId: SELF, identity: "ticket-1" }), SELF),
    ).toBe(false);
  });
});
