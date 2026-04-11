// agent-bridge mcp — MCP adapter for Claude Code, Codex, Gemini CLI
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { McpAgentBridge } from "../../mcp/adapter.js";

export function registerMcpCommand(program: Command): void {
  const mcp = program.command("mcp").description("MCP adapter — connect agent-bridge to Claude Code, Codex, or Gemini CLI");

  // ── mcp start ─────────────────────────────────────────────────────────────
  mcp
    .command("start")
    .description(
      "Start MCP adapter in stdio mode (used by Claude Code and other MCP clients). " +
      "Auto-starts an embedded registry and local agent if none are running."
    )
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--project <path>", "Project path for client registration (default: cwd)")
    .option("--no-auto", "Disable auto-start of registry (require manual setup)")
    .action(async (options) => {
      const bridge = new McpAgentBridge({
        registryUrl: options.registryUrl,
        auto: options.auto !== false,
        projectPath: options.project ?? process.env["AGENT_BRIDGE_PROJECT"] ?? process.cwd(),
      });
      await bridge.start("stdio");
    });

  // ── mcp server ────────────────────────────────────────────────────────────
  mcp
    .command("server")
    .description("Start MCP adapter as an HTTP/SSE server (for remote MCP clients)")
    .option("-p, --port <number>", "HTTP port", "6000")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .action(async (options) => {
      const bridge = new McpAgentBridge({
        registryUrl: options.registryUrl,
      });
      console.error(chalk.cyan("[MCP Server] Starting HTTP/SSE MCP server..."));
      await bridge.start("http", parseInt(options.port));
    });

  // ── mcp config ────────────────────────────────────────────────────────────
  mcp
    .command("config")
    .description("Print the .mcp.json config to add agent-bridge to Claude Code")
    .option("--write", "Write .mcp.json to the current directory")
    .option("--global", "Use global installation path (pnpm dlx)")
    .action(async (options) => {
      const cliPath = resolve(process.argv[1]);

      const projectPath = resolve(process.cwd());

      const config = options.global
        ? {
            mcpServers: {
              "agent-bridge": {
                command: "pnpm",
                args: ["dlx", "agent-bridge", "mcp", "start"],
                env: { AGENT_BRIDGE_PROJECT: projectPath },
              },
            },
          }
        : {
            mcpServers: {
              "agent-bridge": {
                command: "node",
                args: [cliPath, "mcp", "start"],
                env: { AGENT_BRIDGE_PROJECT: projectPath },
              },
            },
          };

      const json = JSON.stringify(config, null, 2);

      if (options.write) {
        await writeFile(".mcp.json", json, "utf-8");
        console.log(chalk.green("✓") + " .mcp.json written");
        console.log(chalk.dim(`  Project: ${projectPath}`));
        console.log(chalk.dim("  Restart Claude Code to pick up the new server"));
      } else {
        console.log("\n" + chalk.bold("Add to your .mcp.json:") + "\n");
        console.log(json);
        console.log();
        console.log(chalk.dim("Or run: agent-bridge mcp config --write"));
        console.log(chalk.dim("Or run: claude mcp add agent-bridge -- node " + cliPath + " mcp start"));
      }
    });

  // ── mcp status ────────────────────────────────────────────────────────────
  mcp
    .command("status")
    .description("Show what agents and tools would be available to an MCP client right now")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .action(async (options) => {
      const { RegistryClient } = await import("../../client/registry-client.js");
      const client = new RegistryClient(options.registryUrl);

      try {
        const agents = await client.listAgents({ healthy: true });

        if (agents.length === 0) {
          console.log(chalk.yellow("No healthy agents found. Start agents with: agent-bridge start <path>"));
          return;
        }

        console.log(chalk.bold(`\n${agents.length} agent(s) connected — MCP tools registered:\n`));

        const tools = ["list_agents", "message_client_session", "reply", "channel_inbox"];
        console.log(chalk.cyan("  Channel tools:"));
        for (const t of tools) console.log(`    • ${t}`);
        console.log();

        for (const agent of agents) {
          if (agent.entryType === "client") continue;
          console.log(chalk.cyan(`  Agent: ${agent.name}`) + chalk.dim(` (${agent.projectPath})`));
          for (const skill of agent.card.skills) {
            console.log(`    • skill: ${skill.id} — ${skill.description}`);
          }
          console.log();
        }

        console.log(chalk.bold("To connect Claude Code:"));
        console.log(chalk.dim("  agent-bridge mcp config --write  # writes .mcp.json"));
        console.log(chalk.dim("  agent-bridge mcp start           # or run directly"));
      } catch {
        console.error(chalk.red("Registry not available. Start it with: agent-bridge registry start"));
        process.exit(1);
      }
    });
}
