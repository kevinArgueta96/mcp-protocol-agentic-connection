// Build and write the .mcp.json entry that wires open-agent-bridge into an MCP
// client (Claude Code, etc.). Centralized here so `mcp config`, `init`, and the
// launchers all produce identical, correct configs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCliEntry, isOnPath } from "./runtime.js";

export const MCP_SERVER_NAME = "open-agent-bridge";

/** `linked` invokes the globally-installed binary by name (works after
 *  `npm i -g .` / `pnpm link --global`). `local` invokes node + the resolved
 *  dist path (works from a built checkout without a global install). */
export type McpConfigMode = "linked" | "local";

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BuildMcpConfigOptions {
  projectPath?: string;
  identity?: string;
  mode?: McpConfigMode;
}

/** Prefer the linked global binary when it's on PATH; otherwise fall back to
 *  node + the local dist entry. */
export function defaultMcpMode(): McpConfigMode {
  return isOnPath("open-agent-bridge") || isOnPath("oab") ? "linked" : "local";
}

/** Name of the global binary to invoke in `linked` mode. */
function linkedBinaryName(): string {
  if (isOnPath("open-agent-bridge")) return "open-agent-bridge";
  if (isOnPath("oab")) return "oab";
  return "open-agent-bridge";
}

export function buildMcpServerEntry(opts: BuildMcpConfigOptions = {}): McpServerEntry {
  const projectPath = resolve(opts.projectPath ?? process.cwd());
  const mode = opts.mode ?? defaultMcpMode();

  const env: Record<string, string> = { AGENT_BRIDGE_PROJECT: projectPath };
  // Only bake in an identity when it's a real, non-default namespace — keeps the
  // common case clean (omitting it falls back to "global" at runtime).
  if (opts.identity && opts.identity !== "global") {
    env.AGENT_BRIDGE_IDENTITY = opts.identity;
  }

  if (mode === "linked") {
    return { command: linkedBinaryName(), args: ["mcp", "start"], env };
  }
  return { command: "node", args: [resolveCliEntry(), "mcp", "start"], env };
}

export function buildMcpConfig(opts: BuildMcpConfigOptions = {}): {
  mcpServers: Record<string, McpServerEntry>;
} {
  return { mcpServers: { [MCP_SERVER_NAME]: buildMcpServerEntry(opts) } };
}

interface McpConfigFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Merge the open-agent-bridge entry into an existing .mcp.json without
 *  clobbering other MCP servers. Returns whether an existing file was merged. */
export function writeMcpConfig(targetPath: string, entry: McpServerEntry): { merged: boolean } {
  let root: McpConfigFile = {};
  let merged = false;

  if (existsSync(targetPath)) {
    try {
      root = JSON.parse(readFileSync(targetPath, "utf-8")) as McpConfigFile;
      merged = true;
    } catch {
      // Malformed JSON — overwrite rather than crash.
      root = {};
      merged = false;
    }
  }

  if (!root.mcpServers || typeof root.mcpServers !== "object") {
    root.mcpServers = {};
  }
  root.mcpServers[MCP_SERVER_NAME] = entry;

  writeFileSync(targetPath, JSON.stringify(root, null, 2) + "\n", "utf-8");
  return { merged };
}
