import { describe, it, expect } from "vitest";
import { hostname } from "node:os";
import { classify, isAlive, matchesTarget } from "../cli/commands/prune.js";
import type { RegistryEntry } from "../types/messages.js";

const HOST = hostname();

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    agentId: "client-claude-code-abc123",
    name: "demo",
    url: "",
    wsUrl: "",
    port: 0,
    projectPath: "/tmp/demo",
    projectName: "demo",
    projectType: "unknown",
    card: { name: "demo", description: "", url: "", version: "1", capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false }, defaultInputModes: [], defaultOutputModes: [], skills: [] },
    registeredAt: 0,
    entryType: "client",
    lastHeartbeat: 0,
    healthy: true,
    pid: process.pid,
    host: HOST,
    ...overrides,
  };
}

describe("isAlive", () => {
  it("returns true for the current process", () => {
    expect(isAlive(process.pid)).toBe(true);
  });
  it("returns false for an impossibly high pid", () => {
    expect(isAlive(2_000_000_000)).toBe(false);
  });
});

describe("classify", () => {
  it("flags entries on another host as remote", () => {
    expect(classify(entry({ host: "some-other-box" }), HOST, [])).toBe("remote");
  });

  it("flags pid-less entries with no matching process as dead (stale)", () => {
    expect(classify(entry({ pid: undefined }), HOST, [])).toBe("dead");
  });

  it("flags entries whose stamped pid is gone as dead", () => {
    expect(classify(entry({ pid: 2_000_000_000 }), HOST, [])).toBe("dead");
  });

  it("excludes a process claimed by a pid-stamped entry from a pid-less sibling", () => {
    // Live stamped session (pid 4242) + a pid-less stale entry for the same
    // project must NOT borrow 4242 and look live — it has no process → dead.
    const procs = [{ pid: 4242, ppid: 100, hasTty: true, project: "/tmp/demo" }];
    const claimed = new Set([4242]);
    expect(classify(entry({ pid: undefined, projectPath: "/tmp/demo" }), HOST, procs, claimed)).toBe("dead");
  });

  it("treats a process on a real terminal as live (not orphaned)", () => {
    const procs = [{ pid: 4242, ppid: 100, hasTty: true, project: "/tmp/demo" }];
    expect(classify(entry({ pid: undefined, projectPath: "/tmp/demo" }), HOST, procs)).toBe("live");
  });

  it("treats a process detached from any terminal as orphaned", () => {
    const procs = [{ pid: 4242, ppid: 100, hasTty: false, project: "/tmp/demo" }];
    expect(classify(entry({ pid: undefined, projectPath: "/tmp/demo" }), HOST, procs)).toBe("orphaned");
  });

  it("treats a reparented (ppid 1) process as orphaned even with a tty", () => {
    const procs = [{ pid: 4242, ppid: 1, hasTty: true, project: "/tmp/demo" }];
    expect(classify(entry({ pid: undefined, projectPath: "/tmp/demo" }), HOST, procs)).toBe("orphaned");
  });
});

describe("matchesTarget", () => {
  const e = entry({ agentId: "client-claude-code-327ab59edbf1", name: "arc-api", projectName: "arc-api" });
  it("matches exact agentId", () => expect(matchesTarget(e, "client-claude-code-327ab59edbf1")).toBe(true));
  it("matches agentId prefix", () => expect(matchesTarget(e, "client-claude-code-327")).toBe(true));
  it("matches name substring (case-insensitive)", () => expect(matchesTarget(e, "ARC")).toBe(true));
  it("does not match unrelated text", () => expect(matchesTarget(e, "providers-web")).toBe(false));
});
