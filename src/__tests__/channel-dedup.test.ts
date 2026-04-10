import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelClientRuntime } from "../client/channel-client-runtime.js";
import type { ChannelTransport } from "../client/channel-transport.js";

/**
 * Tests for the emittedMessageIds dedup mechanism in ChannelClientRuntime.
 * Ensures that a message arriving via both broadcast and targeted WS delivery
 * is only emitted once.
 */
describe("ChannelClientRuntime — dedup", () => {
  let runtime: ChannelClientRuntime;
  let mockTransport: ChannelTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    // Minimal transport mock — dedup tests don't need real HTTP/WS
    mockTransport = {
      registerClient: vi.fn().mockResolvedValue(undefined),
      deregisterClient: vi.fn().mockResolvedValue(undefined),
      sendHeartbeat: vi.fn().mockResolvedValue(undefined),
      postChannelMessage: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
      acknowledgeMessage: vi.fn().mockResolvedValue(undefined),
      getConversationSnapshots: vi.fn().mockResolvedValue([]),
      connectWs: vi.fn().mockReturnValue({ close: vi.fn(), on: vi.fn(), readyState: 1 }),
    } as unknown as ChannelTransport;

    runtime = new ChannelClientRuntime({
      transport: mockTransport,
      reconnectDelayMs: 999_999,
      maxReconnectAttempts: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits channel.message once when the same messageId arrives twice", () => {
    const listener = vi.fn();
    runtime.on("channel.message", listener);

    const msg = {
      messageId: "dedup-test-id",
      conversationId: "conv-1",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      content: "hello",
      kind: "chat" as const,
      createdAt: Date.now(),
    };

    // handleRawMessage expects a JSON string wrapping { type: "channel.message", data: ... }
    const raw = JSON.stringify({ type: "channel.message", data: msg });

    // Simulate two deliveries of the same message (broadcast + targeted)
    (runtime as any).handleRawMessage(raw);
    (runtime as any).handleRawMessage(raw);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("emits channel.message for distinct messageIds", () => {
    const listener = vi.fn();
    runtime.on("channel.message", listener);

    const base = {
      conversationId: "conv-1",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      content: "hello",
      kind: "chat" as const,
      createdAt: Date.now(),
    };

    (runtime as any).handleRawMessage(JSON.stringify({ type: "channel.message", data: { ...base, messageId: "id-1" } }));
    (runtime as any).handleRawMessage(JSON.stringify({ type: "channel.message", data: { ...base, messageId: "id-2" } }));

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("allows re-delivery after TTL expires", () => {
    const listener = vi.fn();
    runtime.on("channel.message", listener);

    const msg = {
      messageId: "ttl-test-id",
      conversationId: "conv-1",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      content: "hello",
      kind: "chat" as const,
      createdAt: Date.now(),
    };
    const raw = JSON.stringify({ type: "channel.message", data: msg });

    (runtime as any).handleRawMessage(raw);
    expect(listener).toHaveBeenCalledTimes(1);

    // Advance past the 1-hour TTL
    vi.advanceTimersByTime(3_600_001);

    (runtime as any).handleRawMessage(raw);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
