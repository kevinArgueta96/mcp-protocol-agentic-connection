// `oab claude` — launch Claude Code fully wired to open-agent-bridge in one
// command. Ensures the registry is up, writes .mcp.json if missing, sets the
// identity in the environment, and spawns Claude with the channel flag.
//
// Replaces the user's `claude-oab` shell alias.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { ensureRegistry, DEFAULT_REGISTRY_PORT } from "../lib/runtime.js";
import { buildMcpServerEntry, writeMcpConfig, defaultMcpMode } from "../lib/mcp-config.js";

export function registerLaunchCommand(program: Command): void {
  program
    .command("claude")
    .description("Launch Claude Code wired to open-agent-bridge (registry + .mcp.json + channel)")
    .option("--identity <id>", "Channel namespace — only sessions sharing it see each other (default: global)")
    .option("--project <path>", "Project path (default: cwd)")
    .option("-p, --port <number>", "Registry port", String(DEFAULT_REGISTRY_PORT))
    .allowUnknownOption(true) // pass any extra flags straight through to `claude`
    .allowExcessArguments(true)
    .action(async (options, command) => {
      const projectPath = resolve(options.project ?? process.cwd());
      const port = Number(options.port);
      const identity: string | undefined = options.identity;

      // 1. Ensure the registry is reachable (start a daemon if needed).
      try {
        const { started } = await ensureRegistry({ port, cwd: projectPath });
        console.log(chalk.green("✓") + (started ? ` Registry started on :${port}` : ` Registry already up on :${port}`));
      } catch (err) {
        console.error(chalk.red("✗") + " Could not start registry: " + (err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // 2. Ensure .mcp.json exists for this project.
      const mcpPath = resolve(projectPath, ".mcp.json");
      if (!existsSync(mcpPath)) {
        const entry = buildMcpServerEntry({ projectPath, identity, mode: defaultMcpMode() });
        writeMcpConfig(mcpPath, entry);
        console.log(chalk.green("✓") + " Wrote .mcp.json");
      }

      // 3. Build env + passthrough args, then launch Claude.
      const env: NodeJS.ProcessEnv = { ...process.env, AGENT_BRIDGE_PROJECT: projectPath };
      if (identity) env.AGENT_BRIDGE_IDENTITY = identity;

      const passthrough: string[] = command.args ?? [];
      const args = ["--dangerously-load-development-channels", "server:open-agent-bridge", ...passthrough];

      console.log(chalk.dim(`  Launching: claude ${args.join(" ")}`));
      if (identity) console.log(chalk.dim(`  Identity:  ${identity}`));
      console.log();

      const child = spawn("claude", args, { stdio: "inherit", cwd: projectPath, env });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          console.error(chalk.red("✗") + " `claude` was not found in PATH. Install Claude Code, then retry.");
        } else {
          console.error(chalk.red("✗") + " Failed to launch claude: " + err.message);
        }
        process.exit(1);
      });

      // The registry is a shared daemon — do NOT stop it when Claude exits.
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}
