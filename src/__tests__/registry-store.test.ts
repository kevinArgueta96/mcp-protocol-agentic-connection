import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentStore } from "../registry/store.js";
import type { AgentRegistration } from "../types/messages.js";

function makeRegistration(id: string, overrides: Partial<AgentRegistration> = {}): AgentRegistration {
  return {
    agentId: id,
    name: `Agent ${id}`,
    url: `http://localhost:900${id}`,
    wsUrl: "",
    port: 9000,
    projectPath: `/projects/${id}`,
    projectName: id,
    projectType: "node",
    card: {
      name: id,
      description: "",
      url: "",
      version: "1.0.0",
      protocolVersion: "0.3.0",
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [],
    },
    registeredAt: Date.now(),
    entryType: "agent",
    ...overrides,
  };
}

describe("AgentStore", () => {
  let store: AgentStore;

  beforeEach(() => {
    store = new AgentStore();
  });

  it("registers an agent and marks it healthy", () => {
    store.register(makeRegistration("a1"));
    const entry = store.get("a1");
    expect(entry).toBeDefined();
    expect(entry!.healthy).toBe(true);
  });

  it("deregisters an agent", () => {
    store.register(makeRegistration("a1"));
    expect(store.deregister("a1")).toBe(true);
    expect(store.get("a1")).toBeUndefined();
    expect(store.deregister("a1")).toBe(false);
  });

  it("heartbeat resets healthy and lastHeartbeat", () => {
    store.register(makeRegistration("a1"));
    const before = store.get("a1")!.lastHeartbeat;
    // Advance virtual time slightly
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    store.heartbeat("a1");
    const after = store.get("a1")!.lastHeartbeat;
    expect(after).toBeGreaterThan(before);
    expect(store.get("a1")!.healthy).toBe(true);
    vi.useRealTimers();
  });

  it("heartbeat returns false for unknown agent", () => {
    expect(store.heartbeat("unknown")).toBe(false);
  });

  it("markUnhealthy immediately flags the agent", () => {
    store.register(makeRegistration("a1"));
    expect(store.get("a1")!.healthy).toBe(true);
    store.markUnhealthy("a1");
    expect(store.get("a1")!.healthy).toBe(false);
  });

  it("markUnhealthy is a no-op for already-unhealthy agent", () => {
    const eventBus = { broadcast: vi.fn() };
    store = new AgentStore(eventBus as any);
    store.register(makeRegistration("a1"));
    store.markUnhealthy("a1"); // first call
    eventBus.broadcast.mockClear();
    store.markUnhealthy("a1"); // second call — should not re-broadcast
    expect(eventBus.broadcast).not.toHaveBeenCalled();
  });

  it("healthCheck marks entries unhealthy after 90s", () => {
    vi.useFakeTimers();
    store.register(makeRegistration("a1"));
    vi.advanceTimersByTime(91_000);
    store.healthCheck();
    expect(store.get("a1")!.healthy).toBe(false);
    vi.useRealTimers();
  });

  it("healthCheck removes entries after 120s", () => {
    vi.useFakeTimers();
    store.register(makeRegistration("a1"));
    vi.advanceTimersByTime(121_000);
    store.healthCheck();
    expect(store.get("a1")).toBeUndefined();
    vi.useRealTimers();
  });

  it("re-registering same project agent replaces old entry", () => {
    store.register(makeRegistration("a1", { projectPath: "/projects/myapp" }));
    store.register(makeRegistration("a2", { projectPath: "/projects/myapp" }));
    expect(store.get("a1")).toBeUndefined();
    expect(store.get("a2")).toBeDefined();
    expect(store.count()).toBe(1);
  });

  it("re-registering same client session replaces old entry", () => {
    store.register(makeRegistration("c1", {
      entryType: "client",
      projectPath: "/projects/myapp",
      clientInfo: { clientName: "claude-code", clientVersion: "1.0" },
    }));
    store.register(makeRegistration("c2", {
      entryType: "client",
      projectPath: "/projects/myapp",
      clientInfo: { clientName: "claude-code", clientVersion: "1.0" },
    }));
    expect(store.get("c1")).toBeUndefined();
    expect(store.get("c2")).toBeDefined();
  });

  it("broadcasts agent.unhealthy event when markUnhealthy called", () => {
    const eventBus = { broadcast: vi.fn() };
    store = new AgentStore(eventBus as any);
    store.register(makeRegistration("a1"));
    eventBus.broadcast.mockClear();
    store.markUnhealthy("a1");
    expect(eventBus.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent.unhealthy", data: { agentId: "a1" } })
    );
  });
});
