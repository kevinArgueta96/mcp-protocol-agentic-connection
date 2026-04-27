import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelStore } from "../registry/channel-store.js";

/**
 * Idempotency contract for ChannelStore.createMessage:
 * - With an explicit messageId, repeated calls return the original message and
 *   created=false, so callers can suppress duplicate broadcasts.
 * - Without an explicit messageId, every call creates a new row.
 * - The expired-awaiting-reply scanner picks the right messages for the sweeper.
 */
describe("ChannelStore — createMessage idempotency", () => {
  let tmpDir: string;
  let store: ChannelStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "channel-store-"));
    store = new ChannelStore(join(tmpDir, "test.sqlite"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns created=true for a fresh messageId and persists it", () => {
    const result = store.createMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "hello",
    });
    expect(result.created).toBe(true);
    expect(result.message.messageId).toBe("msg-1");
    expect(result.message.content).toBe("hello");
    expect(store.getMessage("msg-1")).toBeDefined();
  });

  it("returns created=false on a duplicate messageId without overwriting", () => {
    store.createMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "original",
      createdAt: 100,
    });
    const second = store.createMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "DIFFERENT — should be ignored",
      createdAt: 200,
    });
    expect(second.created).toBe(false);
    expect(second.message.content).toBe("original");
    expect(second.message.createdAt).toBe(100);
  });

  it("auto-generates a messageId and creates fresh rows when none is supplied", () => {
    const a = store.createMessage({
      conversationId: "conv-1",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "first",
    });
    const b = store.createMessage({
      conversationId: "conv-1",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "second",
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.message.messageId).not.toBe(b.message.messageId);
  });
});

describe("ChannelStore — deleteConversationsOlderThan", () => {
  let tmpDir: string;
  let store: ChannelStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "channel-store-"));
    store = new ChannelStore(join(tmpDir, "test.sqlite"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes conversations whose latest message is older than the cutoff", () => {
    const oldTs = 1_000;
    const recentTs = 5_000;
    store.createMessage({
      conversationId: "old-conv",
      messageId: "old-msg",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "old",
      createdAt: oldTs,
    });
    store.createMessage({
      conversationId: "recent-conv",
      messageId: "recent-msg",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "recent",
      createdAt: recentTs,
    });

    const removed = store.deleteConversationsOlderThan(3_000);
    expect(removed).toBe(1);
    expect(store.getMessage("old-msg")).toBeUndefined();
    expect(store.getMessage("recent-msg")).toBeDefined();
  });

  it("removes acks and suppression rows for deleted conversations", () => {
    const oldTs = 1_000;
    store.createMessage({
      conversationId: "old-conv",
      messageId: "old-msg",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "old",
      createdAt: oldTs,
    });
    store.addAck({
      conversationId: "old-conv",
      messageId: "old-msg",
      state: "answered",
      actorId: "agent-b",
      actorType: "client",
      timestamp: oldTs + 100,
    });
    store.suppressConversation("old-conv");

    expect(store.deleteConversationsOlderThan(3_000)).toBe(1);
    // Snapshot lookup returns undefined because no messages remain.
    expect(store.getConversation("old-conv")).toBeUndefined();
    // Suppression row was wiped, so a re-creation under the same id works.
    expect(store.isConversationSuppressed("old-conv")).toBe(false);
  });

  it("keeps a conversation alive if any of its messages is recent", () => {
    store.createMessage({
      conversationId: "mixed-conv",
      messageId: "mixed-old",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "old turn",
      createdAt: 1_000,
    });
    store.createMessage({
      conversationId: "mixed-conv",
      messageId: "mixed-new",
      fromAgentId: "agent-b",
      kind: "chat",
      content: "fresh turn",
      createdAt: 5_000,
    });
    expect(store.deleteConversationsOlderThan(3_000)).toBe(0);
    expect(store.getMessage("mixed-old")).toBeDefined();
    expect(store.getMessage("mixed-new")).toBeDefined();
  });

  it("returns 0 when nothing is stale", () => {
    store.createMessage({
      conversationId: "fresh",
      messageId: "msg",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "hi",
      createdAt: Date.now(),
    });
    expect(store.deleteConversationsOlderThan(0)).toBe(0);
  });
});

describe("ChannelStore — findExpiredAwaitingReply", () => {
  let tmpDir: string;
  let store: ChannelStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "channel-store-"));
    store = new ChannelStore(join(tmpDir, "test.sqlite"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns messages past their expiresAt with no terminal ack", () => {
    const past = Date.now() - 60_000;
    store.createMessage({
      conversationId: "conv-expired",
      messageId: "msg-expired",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "ping",
      expectsResponse: true,
      expiresAt: past,
    });
    const found = store.findExpiredAwaitingReply(Date.now());
    expect(found.map((m) => m.messageId)).toContain("msg-expired");
  });

  it("skips messages that already have an answered ack", () => {
    const past = Date.now() - 60_000;
    store.createMessage({
      conversationId: "conv-answered",
      messageId: "msg-answered",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "ping",
      expectsResponse: true,
      expiresAt: past,
    });
    store.addAck({
      conversationId: "conv-answered",
      messageId: "msg-answered",
      state: "answered",
      actorId: "agent-b",
      actorType: "client",
      timestamp: Date.now() - 30_000,
    });
    const found = store.findExpiredAwaitingReply(Date.now());
    expect(found.map((m) => m.messageId)).not.toContain("msg-answered");
  });

  it("skips messages that did not request a response", () => {
    const past = Date.now() - 60_000;
    store.createMessage({
      conversationId: "conv-broadcast",
      messageId: "msg-broadcast",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "fyi",
      expectsResponse: false,
      expiresAt: past,
    });
    const found = store.findExpiredAwaitingReply(Date.now());
    expect(found.map((m) => m.messageId)).not.toContain("msg-broadcast");
  });

  it("skips messages whose expiresAt is still in the future", () => {
    const future = Date.now() + 60_000;
    store.createMessage({
      conversationId: "conv-pending",
      messageId: "msg-pending",
      fromAgentId: "agent-a",
      kind: "chat",
      content: "ping",
      expectsResponse: true,
      expiresAt: future,
    });
    const found = store.findExpiredAwaitingReply(Date.now());
    expect(found.map((m) => m.messageId)).not.toContain("msg-pending");
  });
});
