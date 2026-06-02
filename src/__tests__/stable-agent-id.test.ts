import { describe, expect, it } from "vitest";
import { buildStableClientAgentId } from "../mcp/adapter.js";

/**
 * The stable agentId encodes (clientName, projectPath, identity) so that two
 * sessions of the same client+project but different `--identity` register as
 * distinct agents. Omitting identity is equivalent to the "global" namespace.
 */

describe("buildStableClientAgentId", () => {
  it("is deterministic for the same inputs", () => {
    expect(buildStableClientAgentId("antigravity-client", "/w/a", "ticket-1")).toBe(
      buildStableClientAgentId("antigravity-client", "/w/a", "ticket-1"),
    );
  });

  it("produces different ids for different identities (same client+project)", () => {
    const a = buildStableClientAgentId("antigravity-client", "/w/a", "ticket-1");
    const b = buildStableClientAgentId("antigravity-client", "/w/a", "ticket-2");
    expect(a).not.toBe(b);
  });

  it("treats omitted identity as 'global'", () => {
    expect(buildStableClientAgentId("claude-code", "/w/a")).toBe(
      buildStableClientAgentId("claude-code", "/w/a", "global"),
    );
  });

  it("keeps the client- prefix and clientName for readability", () => {
    expect(buildStableClientAgentId("codex-cli", "/w/a", "global")).toMatch(/^client-codex-cli-[0-9a-f]{12}$/);
  });
});
