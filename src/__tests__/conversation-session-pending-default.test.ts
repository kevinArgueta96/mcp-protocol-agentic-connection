import { describe, expect, it } from "vitest";
import { ConversationSessionStore } from "../client/conversation-session-store.js";
import type { ChannelMessage } from "../types/messages.js";

/**
 * Regression test for the `expectsResponse` default-true behavior in
 * ConversationSessionStore.trackMessage.
 *
 * Why this exists: when Claude posts a message via `message_client_session`
 * without explicitly setting `expectsResponse`, the registry persists the
 * message with `expectsResponse: undefined`. Before this fix, the inner MCP
 * client of Codex/Gemini would NOT surface the message in
 * `channel_inbox(pendingOnly=true)` because trackMessage required
 * `expectsResponse === true` to add the message to pendingMessageIds.
 *
 * After the fix:
 * - undefined expectsResponse → treated as pending
 * - explicit true            → treated as pending
 * - explicit false           → fire-and-forget, NOT pending
 */

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    conversationId: "conv-A",
    messageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
    fromAgentId: "client-claude-sender",
    fromAgentName: "claude",
    toAgentId: "client-codex-bridge-recv",
    kind: "chat",
    content: "hi",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("ConversationSessionStore.trackMessage — pending default", () => {
  it("treats expectsResponse=undefined as pending (the common case)", () => {
    const store = new ConversationSessionStore();
    const msg = makeMessage({ messageId: "msg-1" });
    delete (msg as Partial<ChannelMessage>).expectsResponse;

    const state = store.trackMessage(msg)!;

    expect(state.pendingMessageIds).toContain("msg-1");
    expect(state.awaitingReply).toBe(true);
  });

  it("treats expectsResponse=true as pending", () => {
    const store = new ConversationSessionStore();
    const state = store.trackMessage(makeMessage({ messageId: "msg-2", expectsResponse: true }))!;

    expect(state.pendingMessageIds).toContain("msg-2");
    expect(state.awaitingReply).toBe(true);
  });

  it("treats expectsResponse=false as fire-and-forget — NOT pending", () => {
    const store = new ConversationSessionStore();
    const state = store.trackMessage(makeMessage({ messageId: "msg-3", expectsResponse: false }))!;

    expect(state.pendingMessageIds).not.toContain("msg-3");
    expect(state.awaitingReply).toBe(false);
  });

  it("removes the replyTo target from pending when a reply arrives", () => {
    const store = new ConversationSessionStore();
    store.trackMessage(makeMessage({ messageId: "msg-4-question" })); // implicit pending
    const replyState = store.trackMessage(
      makeMessage({
        messageId: "msg-5-answer",
        replyTo: "msg-4-question",
        fromAgentId: "client-codex-bridge-recv",
        toAgentId: "client-claude-sender",
      }),
    )!;

    // The original question is no longer pending. The reply itself is pending
    // (it might still expect a follow-up — the receiver clears it via its own
    // reply or via terminal ack).
    expect(replyState.pendingMessageIds).not.toContain("msg-4-question");
    expect(replyState.pendingMessageIds).toContain("msg-5-answer");
  });

  it("a terminal `answered` ack clears the message from pending and stops awaiting", () => {
    const store = new ConversationSessionStore();
    store.trackMessage(makeMessage({ messageId: "msg-6" })); // implicit pending
    const ackedState = store.trackAck({
      conversationId: "conv-A",
      messageId: "msg-6",
      state: "answered",
      actorId: "client-codex-bridge-recv",
      actorType: "client",
      timestamp: Date.now(),
    })!;

    expect(ackedState.pendingMessageIds).not.toContain("msg-6");
    expect(ackedState.awaitingReply).toBe(false);
  });
});
