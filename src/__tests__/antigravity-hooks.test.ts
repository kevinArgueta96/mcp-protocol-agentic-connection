import { describe, expect, it } from "vitest";
import {
  buildSessionStartHookOutput,
  buildStopHookOutput,
} from "../client/antigravity-hooks.js";

/**
 * The Stop hook is Antigravity's native auto-arrival trigger: when the agent
 * tries to stop, returning {"decision":"block","reason":...} forces it to keep
 * going with the reason text as input. We use it to deliver pending channel
 * messages so the agent answers them without a human re-prompt.
 */

describe("buildStopHookOutput", () => {
  it("blocks the stop and names pending senders when messages are pending", () => {
    const out = buildStopHookOutput([
      { fromAgentName: "claude", content: "review the PR", conversationId: "c1" },
      { fromAgentName: "codex", content: "ping", conversationId: "c2" },
    ]);

    expect(out.decision).toBe("block");
    expect(out.reason).toContain("channel_inbox");
    expect(out.reason).toContain("2");
  });

  it("returns an empty object (allows stop) when nothing is pending", () => {
    expect(buildStopHookOutput([])).toEqual({});
  });
});

describe("buildSessionStartHookOutput", () => {
  it("injects additionalContext describing the bridge when pending exist", () => {
    const out = buildSessionStartHookOutput(1);
    expect(out.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput?.additionalContext).toContain("channel_inbox");
  });

  it("returns an empty object when no pending messages", () => {
    expect(buildSessionStartHookOutput(0)).toEqual({});
  });
});
