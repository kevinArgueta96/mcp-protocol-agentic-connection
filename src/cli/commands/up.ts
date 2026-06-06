// Top-level lifecycle commands: `oab up` / `oab down` / `oab status`.
// These wrap the registry daemon so users no longer keep a terminal open.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { RegistryClient } from "../../client/registry-client.js";
import {
  startDaemon,
  stopDaemon,
  readPid,
  isPidAlive,
  DEFAULT_REGISTRY_PORT,
} from "../lib/runtime.js";

export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description("Start the registry in the background (idempotent) — no dedicated terminal needed")
    .option("-p, --port <number>", "Registry port", String(DEFAULT_REGISTRY_PORT))
    .action(async (options) => {
      const port = Number(options.port);
      try {
        const { alreadyRunning, pid } = await startDaemon({ port });
        if (alreadyRunning) {
          console.log(chalk.green("✓") + ` Registry already up on http://localhost:${port}`);
        } else {
          console.log(chalk.green("✓") + ` Registry up on http://localhost:${port}` + chalk.dim(` (pid ${pid})`));
        }
        console.log(chalk.dim(`  Dashboard: http://localhost:${port}/dashboard`));
      } catch (err) {
        console.error(chalk.red("✗") + " " + (err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("down")
    .description("Stop the background registry")
    .action(async () => {
      const res = await stopDaemon();
      if (res.stopped) {
        console.log(chalk.green("✓") + " Registry stopped");
      } else if (res.reason === "not-running") {
        console.log(chalk.dim("Registry was not running"));
      } else if (res.reason === "stale-pid-cleared") {
        console.log(chalk.yellow("⚠") + " Cleared a stale PID file (process was already gone)");
      } else {
        console.log(chalk.yellow("⚠") + " A registry is running but was not started as a daemon here — stop it where it was launched.");
      }
    });

  program
    .command("status")
    .description("Show registry health, connected agents, and .mcp.json presence")
    .option("--registry-url <url>", "Registry URL", `http://localhost:${DEFAULT_REGISTRY_PORT}`)
    .action(async (options) => {
      const client = new RegistryClient(options.registryUrl);
      const up = await client.isAvailable();

      if (!up) {
        console.log(chalk.red("✗") + " Registry: down" + chalk.dim(`  (${options.registryUrl})`));
        console.log(chalk.dim("  Start it with: oab up"));
        return;
      }

      const health = await client.health();
      console.log(chalk.green("✓") + " Registry: up");
      console.log(`  URL:       ${options.registryUrl}`);
      console.log(`  Agents:    ${health.agents}`);

      const pid = readPid();
      if (pid && isPidAlive(pid)) {
        console.log(`  Daemon:    pid ${pid}`);
      }

      const mcpPath = resolve(".mcp.json");
      console.log(`  .mcp.json: ${existsSync(mcpPath) ? chalk.green("present") : chalk.dim("absent (run: oab init)")}`);
    });
}
