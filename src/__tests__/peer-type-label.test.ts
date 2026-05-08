import { describe, expect, it } from "vitest";
import { getPeerType, getPeerTypeLabel } from "../mcp/adapter.js";
import type { RegistryEntry } from "../types/messages.js";

/**
 * Pure-function tests for the peer-type taxonomy used in `list_agents` and
 * `channel_inbox` output. These guards exist so a future refactor of the
 * heuristic (clientName / clientVersion → peerType) can't silently mislabel a
 * Codex bridge as "unknown" or merge Claude with Codex.
 */

function entry(overrides: Partial<RegistryEntry> & { agentId?: string }): RegistryEntry {
  // Build a minimal RegistryEntry stub. Fields required by the type are
  // populated with empty/neutral values so the heuristic only reads
  // clientInfo + agentId.
  return {
    agentId: overrides.agentId ?? "client-stub-0001",
    name: "stub",
    url: "",
    wsUrl: "",
    port: 0,
    projectPath: "/tmp",
    projectName: "stub",
    projectType: "unknown",
    card: {
      name: "stub",
      description: "",
      url: "",
      version: "0",
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [],
    },
    registeredAt: 0,
    entryType: "client",
    ...overrides,
  } as RegistryEntry;
}

describe("getPeerType", () => {
  it("classifies Claude Code by clientName 'claude-code'", () => {
    expect(getPeerType(entry({ clientInfo: { clientName: "claude-code", clientVersion: "2.1" } }))).toBe(
      "claude-code",
    );
  });

  it("classifies Claude by clientName 'claude'", () => {
    expect(getPeerType(entry({ clientInfo: { clientName: "Claude", clientVersion: "anything" } }))).toBe(
      "claude-code",
    );
  });

  it("classifies Codex bridge by clientVersion 'app-server-bridge'", () => {
    expect(
      getPeerType(entry({ clientInfo: { clientName: "codex", clientVersion: "app-server-bridge" } })),
    ).toBe("codex-bridge");
  });

  it("classifies Codex inner by clientName containing 'codex' without bridge clientVersion", () => {
    expect(
      getPeerType(entry({ clientInfo: { clientName: "codex-cli", clientVersion: "0.128.0" } })),
    ).toBe("codex-inner");
  });

  it("classifies Gemini bridge by clientVersion 'acp-bridge'", () => {
    expect(
      getPeerType(entry({ clientInfo: { clientName: "gemini", clientVersion: "acp-bridge" } })),
    ).toBe("gemini-bridge");
  });

  it("classifies Gemini inner by clientName containing 'gemini' without bridge clientVersion", () => {
    expect(
      getPeerType(entry({ clientInfo: { clientName: "gemini-cli", clientVersion: "0.5" } })),
    ).toBe("gemini-inner");
  });

  it("classifies dashboard-ui by stable agentId", () => {
    expect(
      getPeerType(
        entry({
          agentId: "client-dashboard-ui",
          clientInfo: { clientName: "anything", clientVersion: "anything" },
        }),
      ),
    ).toBe("dashboard-ui");
  });

  it("falls back to 'unknown' for unrecognized clients", () => {
    expect(
      getPeerType(entry({ clientInfo: { clientName: "vscode-llm", clientVersion: "1.0" } })),
    ).toBe("unknown");
  });

  it("treats missing clientInfo as 'unknown'", () => {
    // Cast through unknown because the canonical RegistryEntry typing requires
    // clientInfo for "client" entries; we want to exercise the defensive path.
    expect(getPeerType(entry({ clientInfo: undefined } as unknown as Partial<RegistryEntry>))).toBe(
      "unknown",
    );
  });
});

describe("getPeerTypeLabel", () => {
  it("maps each peerType to its human label", () => {
    const cases: Array<[Partial<RegistryEntry>, string]> = [
      [{ clientInfo: { clientName: "claude-code", clientVersion: "2.0" } }, "Claude Code"],
      [{ clientInfo: { clientName: "codex", clientVersion: "app-server-bridge" } }, "Codex bridge"],
      [{ clientInfo: { clientName: "codex-cli", clientVersion: "0.1" } }, "Codex inner"],
      [{ clientInfo: { clientName: "gemini", clientVersion: "acp-bridge" } }, "Gemini bridge"],
      [{ clientInfo: { clientName: "gemini-cli", clientVersion: "0.5" } }, "Gemini inner"],
      [
        { agentId: "client-dashboard-ui", clientInfo: { clientName: "x", clientVersion: "y" } },
        "Dashboard UI",
      ],
    ];
    for (const [overrides, label] of cases) {
      expect(getPeerTypeLabel(entry(overrides))).toBe(label);
    }
  });

  it("falls back to clientName for unknown peers, not the literal 'unknown'", () => {
    expect(
      getPeerTypeLabel(entry({ clientInfo: { clientName: "vscode-llm", clientVersion: "1.0" } })),
    ).toBe("vscode-llm");
  });
});
