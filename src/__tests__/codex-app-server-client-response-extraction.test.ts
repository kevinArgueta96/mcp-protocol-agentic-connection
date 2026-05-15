import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../client/codex-app-server-client.js";

type Extractor = {
  extractTurnResponseText: (result: unknown) => string;
  handleNotification: (message: unknown) => void;
  currentThreadId: string | null;
  turnInProgress: boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

describe("CodexAppServerClient response extraction", () => {
  const client = new CodexAppServerClient() as unknown as Extractor;

  it("extracts classic agentMessage output_text content", () => {
    expect(
      client.extractTurnResponseText({
        output: [
          {
            type: "agentMessage",
            content: [{ type: "output_text", text: "OK" }],
          },
        ],
      }),
    ).toBe("OK");
  });

  it("extracts assistant text from item-based results", () => {
    expect(
      client.extractTurnResponseText({
        items: [
          {
            type: "assistantMessage",
            content: [{ type: "output_text", text: "ack" }],
          },
        ],
      }),
    ).toBe("ack");
  });

  it("extracts nested assistant role message text", () => {
    expect(
      client.extractTurnResponseText({
        data: {
          message: {
            role: "assistant",
            content: [{ type: "output_text", text: "recibido" }],
          },
        },
      }),
    ).toBe("recibido");
  });

  it("tracks the active status thread instead of keeping a stale thread/started id", () => {
    const subject = new CodexAppServerClient() as unknown as Extractor;
    const detectedThreads: unknown[] = [];
    const completedTurns: unknown[] = [];
    subject.on("threadDetected", (threadId) => detectedThreads.push(threadId));
    subject.on("turnCompleted", (turnId) => completedTurns.push(turnId));

    subject.handleNotification({
      method: "thread/started",
      params: { thread: { id: "stale-thread" } },
    });
    expect(subject.currentThreadId).toBe("stale-thread");

    subject.handleNotification({
      method: "thread/status/changed",
      params: { threadId: "active-thread", status: { type: "active" } },
    });
    expect(subject.currentThreadId).toBe("active-thread");
    expect(subject.turnInProgress).toBe(true);

    subject.handleNotification({
      method: "thread/status/changed",
      params: { threadId: "active-thread", status: { type: "idle" } },
    });
    expect(subject.turnInProgress).toBe(false);
    expect(detectedThreads).toEqual(["stale-thread", "active-thread"]);
    expect(completedTurns).toEqual(["status-idle"]);
  });
});
