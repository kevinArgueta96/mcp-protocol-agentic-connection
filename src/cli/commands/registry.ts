// open-agent-bridge registry start|stop|status
import type { Command } from "commander";
import chalk from "chalk";
import { RegistryServer } from "../../registry/server.js";
import { RegistryClient } from "../../client/registry-client.js";
import { startDaemon, stopDaemon, DEFAULT_REGISTRY_PORT } from "../lib/runtime.js";

export function registerRegistryCommand(program: Command): void {
  const registry = program.command("registry").description("Manage the agent registry");

  registry
    .command("start")
    .description("Start the registry server on :4999 (foreground, or --daemon for background)")
    .option("-p, --port <number>", "Port (default: 4999)", parseInt)
    .option("-d, --daemon", "Run detached in the background and return immediately")
    .action(async (options) => {
      const port = options.port ?? DEFAULT_REGISTRY_PORT;

      if (options.daemon) {
        const { alreadyRunning, pid } = await startDaemon({ port });
        if (alreadyRunning) {
          console.log(chalk.green("✓") + ` Registry already running on http://localhost:${port}`);
        } else {
          console.log(chalk.green("✓") + ` Registry daemon started on http://localhost:${port}` + chalk.dim(` (pid ${pid})`));
        }
        return;
      }

      const server = new RegistryServer(port);
      await server.start();
      console.log(chalk.green("✓") + ` Registry running on http://localhost:${port}`);
      const stop = async () => { await server.stop(); process.exit(0); };
      process.on("SIGINT", () => void stop());
      process.on("SIGTERM", () => void stop());
      process.on("SIGHUP", () => void stop());
    });

  registry
    .command("stop")
    .description("Stop the background registry daemon")
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

  registry
    .command("status")
    .description("Show registry health and agent count")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .action(async (options) => {
      const client = new RegistryClient(options.registryUrl);
      try {
        const health = await client.health();
        console.log(chalk.green("✓") + " Registry is healthy");
        console.log(`  Agents: ${health.agents}`);
      } catch {
        console.log(chalk.red("✗") + " Registry not available at " + options.registryUrl);
      }
    });
}
