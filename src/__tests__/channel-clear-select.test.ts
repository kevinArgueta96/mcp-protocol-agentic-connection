import { describe, expect, it } from "vitest";
import { selectConversationsToClear } from "../mcp/clear-scope.js";

/**
 * channel_clear lets an agent clean its inbox so saturation never buries new
 * messages. The scope selector decides WHICH of the agent's tracked
 * conversations to clear — never the still-pending (unanswered) ones unless an
 * explicit conversationId is given.
 */

const convs = [
  { conversationId: "c-pending", status: "pending" as const },
  { conversationId: "c-answered", status: "answered" as const },
  { conversationId: "c-failed", status: "failed" as const },
  { conversationId: "c-expired", status: "expired" as const },
  { conversationId: "c-active", status: "active" as const },
];

describe("selectConversationsToClear", () => {
  it("scope 'answered' selects only answered", () => {
    expect(selectConversationsToClear(convs, "answered")).toEqual(["c-answered"]);
  });

  it("scope 'failed' selects failed and expired", () => {
    expect(selectConversationsToClear(convs, "failed").sort()).toEqual(["c-expired", "c-failed"]);
  });

  it("scope 'all' clears every non-pending conversation (keeps unanswered)", () => {
    const got = selectConversationsToClear(convs, "all").sort();
    expect(got).toEqual(["c-active", "c-answered", "c-expired", "c-failed"]);
    expect(got).not.toContain("c-pending");
  });

  it("an explicit conversationId clears exactly that one, even if pending", () => {
    expect(selectConversationsToClear(convs, "c-pending")).toEqual(["c-pending"]);
  });

  it("returns empty for an unknown conversationId", () => {
    expect(selectConversationsToClear(convs, "c-nope")).toEqual([]);
  });
});
