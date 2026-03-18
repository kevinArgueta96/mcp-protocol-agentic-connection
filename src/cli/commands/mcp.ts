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
    .option("--project <path>", "Project path for the auto-started agent (default: cwd)")
    .option("--no-auto", "Disable auto-start of registry/agent (require manual setup)")
    .option("--no-skill-tools", "Only register meta-tools, not per-agent skill tools")
    .action(async (options) => {
      const bridge = new McpAgentBridge({
        registryUrl: options.registryUrl,
        auto: options.auto !== false,
        projectPath: options.project ?? process.env["AGENT_BRIDGE_PROJECT"] ?? process.cwd(),
        registerSkillTools: options.skillTools !== false,
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
        registerSkillTools: true,
      });
      console.error(chalk.cyan("[MCP Server] Starting HTTP/SSE MCP server..."));
      await bridge.start("http", parseInt(options.port));
    });

  // ── mcp config ────────────────────────────────────────────────────────────
  mcp
    .command("config")
    .description("Print the .mcp.json config to add agent-bridge to Claude Code")
    .option("--write", "Write .mcp.json to the current directory")
    .option("--global", "Use global installation path (npx)")
    .action(async (options) => {
      const cliPath = resolve(process.argv[1]);

      const projectPath = resolve(process.cwd());

      const config = options.global
        ? {
            mcpServers: {
              "agent-bridge": {
                command: "npx",
                args: ["agent-bridge", "mcp", "start"],
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

        console.log(chalk.bold(`\n${agents.length} agent(s) connected — MCP tools that would be registered:\n`));

        // Meta-tools
        const metaTools = ["list_agents", "agent_health", "ask_agent", "project_info", "project_files"];
        console.log(chalk.cyan("  Meta-tools:"));
        for (const t of metaTools) console.log(`    • ${t}`);
        console.log();

        // Per-agent tools
        for (const agent of agents) {
          const prefix = agent.name.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_").toLowerCase();
          console.log(chalk.cyan(`  ${agent.name}`) + chalk.dim(` (${agent.projectPath})`));
          for (const skill of agent.card.skills) {
            const toolName = `${prefix}__${skill.id.replace(/-/g, "_")}`;
            console.log(`    • ${toolName}`);
            console.log(chalk.dim(`        ${skill.description}`));
          }
          console.log();
        }

        // Resources
        console.log(chalk.cyan("  Resources:"));
        console.log("    • agents://connected  (list of all agents)");
        for (const agent of agents) {
          console.log(`    • agents://${agent.agentId.slice(0, 8)}.../card  (${agent.name} Agent Card)`);
        }

        console.log();
        console.log(chalk.bold("To connect Claude Code:"));
        console.log(chalk.dim("  agent-bridge mcp config --write  # writes .mcp.json"));
        console.log(chalk.dim("  agent-bridge mcp start           # or run directly"));
      } catch {
        console.error(chalk.red("Registry not available. Start it with: agent-bridge registry start"));
        process.exit(1);
      }
    });
}
