import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../client/codex-app-server-client.js";

type Extractor = {
  extractTurnResponseText: (result: unknown) => string;
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
});
