import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelClientRuntime } from "../client/channel-client-runtime.js";
import type { ChannelTransport } from "../client/channel-transport.js";
import type { ChannelAck, ChannelMessage } from "../types/messages.js";

/**
 * seedFromSnapshot must replay BOTH messages and acknowledgements so that, after
 * a sync, the local store reflects whether each conversation was already
 * answered. Without ack replay, restarting the client re-surfaced every prior
 * message as if pending — the bug fixed in docs/channel-reliability.md (Bug 2).
 */
describe("ChannelClientRuntime — seedFromSnapshot", () => {
  let runtime: ChannelClientRuntime;
  let transport: ChannelTransport;

  const buildMessage = (overrides: Partial<ChannelMessage>): ChannelMessage => ({
    messageId: "msg-1",
    conversationId: "conv-1",
    fromAgentId: "peer-a",
    toAgentId: "self-a",
    content: "ping",
    kind: "chat",
    createdAt: Date.now(),
    expectsResponse: true,
    ...overrides,
  });

  const buildAck = (overrides: Partial<ChannelAck>): ChannelAck => ({
    conversationId: "conv-1",
    messageId: "msg-1",
    state: "answered",
    actorId: "self-a",
    actorType: "client",
    timestamp: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    transport = {
      registerClient: vi.fn().mockResolvedValue(undefined),
      deregisterClient: vi.fn().mockResolvedValue(undefined),
      sendHeartbeat: vi.fn().mockResolvedValue(undefined),
      postChannelMessage: vi.fn().mockResolvedValue({}),
      postChannelAck: vi.fn().mockResolvedValue(undefined),
      identifyWebSocket: vi.fn(),
      getRegistryUrl: () => "http://localhost:0",
      getRegistryWsUrl: () => "ws://localhost:0/ws",
      connectWebSocket: vi.fn(() => ({ close: vi.fn(), on: vi.fn(), readyState: 1 })),
    } as unknown as ChannelTransport;

    runtime = new ChannelClientRuntime({
      transport,
      reconnectDelayMs: 999_999,
      maxReconnectAttempts: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays messages alone when acks are not provided (legacy behaviour)", () => {
    const msg = buildMessage({});
    runtime.seedFromSnapshot([msg]);
    const conv = runtime.getConversation("conv-1");
    expect(conv?.messageIds).toContain("msg-1");
    // expectsResponse=true and no ack means awaitingReply stays true.
    expect(conv?.awaitingReply).toBe(true);
    expect(conv?.lastAckState).toBeUndefined();
  });

  it("reconstructs lastAckState=answered when an answered ack is replayed", () => {
    const msg = buildMessage({});
    const ack = buildAck({ state: "answered", timestamp: 1_000 });
    runtime.seedFromSnapshot([msg], [ack]);
    const conv = runtime.getConversation("conv-1");
    expect(conv?.lastAckState).toBe("answered");
    // answered ack on the original messageId clears the pending list.
    expect(conv?.awaitingReply).toBe(false);
    expect(conv?.pendingMessageIds).not.toContain("msg-1");
  });

  it("applies acks in timestamp order so the latest one wins", () => {
    const msg = buildMessage({});
    const acks: ChannelAck[] = [
      buildAck({ state: "answered", timestamp: 2_000 }),       // newer, applied last
      buildAck({ state: "delivered_to_bridge", timestamp: 1_000 }), // older
    ];
    runtime.seedFromSnapshot([msg], acks);
    const conv = runtime.getConversation("conv-1");
    expect(conv?.lastAckState).toBe("answered");
  });

  it("keeps awaitingReply true when only a non-terminal ack is replayed", () => {
    const msg = buildMessage({});
    const ack = buildAck({ state: "delivered_to_bridge", timestamp: 1_000 });
    runtime.seedFromSnapshot([msg], [ack]);
    const conv = runtime.getConversation("conv-1");
    expect(conv?.lastAckState).toBe("delivered_to_bridge");
    expect(conv?.awaitingReply).toBe(true);
  });
});
