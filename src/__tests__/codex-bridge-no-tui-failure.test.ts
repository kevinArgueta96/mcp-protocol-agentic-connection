import { describe, expect, it, vi } from "vitest";
import { CodexAppServerBridge } from "../client/codex-app-server-bridge.js";
import type { ChannelMessage } from "../types/messages.js";

describe("CodexAppServerBridge — no TUI attached", () => {
  it("fails queued messages when no Codex TUI attaches to the bridge app-server", async () => {
    const bridge = new CodexAppServerBridge({
      projectPath: "/tmp/open-agent-bridge-test",
      appServerPort: 4517,
    });
    const postedAcks: unknown[] = [];

    const subject = bridge as unknown as {
      client: { currentThreadId: string | null; turnInProgress: boolean };
      clientAgentId: string;
      channelTransport: { postChannelAck: (ack: unknown) => Promise<void> };
      pendingQueue: Array<{ message: ChannelMessage; retries: number; enqueuedAt: number }>;
      enqueueOrInject: (message: ChannelMessage) => void;
      failStaleQueuedMessages: (now?: number) => Promise<void>;
    };

    subject.client = { currentThreadId: null, turnInProgress: false };
    subject.clientAgentId = "client-codex-bridge-test";
    subject.channelTransport = {
      postChannelAck: vi.fn(async (ack: unknown) => {
        postedAcks.push(ack);
      }),
    };

    const message: ChannelMessage = {
      conversationId: "conv-no-tui",
      messageId: "msg-no-tui",
      fromAgentId: "client-claude-code-test",
      toAgentId: "client-codex-bridge-test",
      kind: "chat",
      content: "hello codex",
      createdAt: 1_000,
      expectsResponse: true,
    };

    subject.enqueueOrInject(message);
    expect(subject.pendingQueue).toHaveLength(1);

    const queued = subject.pendingQueue[0];
    expect(queued).toBeDefined();

    const enqueuedAt = queued?.enqueuedAt ?? 0;
    await subject.failStaleQueuedMessages(enqueuedAt + 31_000);

    expect(subject.pendingQueue).toHaveLength(0);
    expect(postedAcks).toEqual([
      expect.objectContaining({
        conversationId: "conv-no-tui",
        messageId: "msg-no-tui",
        state: "failed",
        actorId: "client-codex-bridge-test",
        actorType: "bridge",
        detail:
          "No Codex TUI attached to bridge app-server. Run: codex --remote ws://127.0.0.1:4517",
      }),
    ]);
  });
});
