// agent-bridge registry start|status
import type { Command } from "commander";
import chalk from "chalk";
import { RegistryServer } from "../../registry/server.js";
import { RegistryClient } from "../../client/registry-client.js";

export function registerRegistryCommand(program: Command): void {
  const registry = program.command("registry").description("Manage the agent registry");

  registry
    .command("start")
    .description("Start the registry server on :4999")
    .option("-p, --port <number>", "Port (default: 4999)", parseInt)
    .action(async (options) => {
      const server = new RegistryServer(options.port);
      await server.start();
      console.log(chalk.green("✓") + " Registry running on http://localhost:4999");
      process.on("SIGINT", async () => {
        await server.stop();
        process.exit(0);
      });
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
