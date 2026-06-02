import { describe, expect, it } from "vitest";
import { isInteractiveAntigravityPane } from "../client/antigravity-runtime-discovery.js";
import type { TmuxPaneInfo } from "../client/codex-runtime-discovery.js";

function pane(currentCommand: string): TmuxPaneInfo {
  return {
    sessionName: "s",
    windowRef: "s:0",
    paneId: "%1",
    title: "t",
    currentCommand,
    currentPath: "/w/a",
  };
}

describe("isInteractiveAntigravityPane", () => {
  it("recognises an 'agy' pane", () => {
    expect(isInteractiveAntigravityPane(pane("agy"))).toBe(true);
  });

  it("recognises the 'antigravity' binary name", () => {
    expect(isInteractiveAntigravityPane(pane("antigravity"))).toBe(true);
  });

  it("rejects unrelated panes and undefined", () => {
    expect(isInteractiveAntigravityPane(pane("bash"))).toBe(false);
    expect(isInteractiveAntigravityPane(undefined)).toBe(false);
  });
});
