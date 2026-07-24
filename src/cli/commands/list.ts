// open-agent-bridge list
import type { Command } from "commander";
import chalk from "chalk";
import { RegistryClient } from "../../client/registry-client.js";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List all active agents")
    .option("--skill <tag>", "Filter by skill tag")
    .option("--project <path>", "Filter by project name or path")
    .option("--json", "Output as JSON")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .action(async (options) => {
      const client = new RegistryClient(options.registryUrl);

      try {
        const agents = await client.listAgents({
          skill: options.skill,
          project: options.project,
        });

        if (options.json) {
          console.log(JSON.stringify(agents, null, 2));
          return;
        }

        if (agents.length === 0) {
          console.log(chalk.yellow("No agents found"));
          return;
        }

        console.log(chalk.bold(`\nActive agents (${agents.length})\n`));
        for (const agent of agents) {
          const health = agent.healthy ? chalk.green("● healthy") : chalk.red("● unhealthy");
          console.log(`  ${health}  ${chalk.cyan(agent.name)}`);
          console.log(`    ID:      ${agent.agentId}`);
          if (agent.pid) console.log(`    PID:     ${agent.pid}${agent.host ? ` @ ${agent.host}` : ""}`);
          // Client sessions (MCP adapters) don't listen anywhere — port 0 is noise.
          if (agent.port) console.log(`    Port:    ${agent.port}`);
          console.log(`    Path:    ${agent.projectPath}`);
          console.log(`    Type:    ${agent.projectType}`);
          if (agent.identity) console.log(`    Identity: ${chalk.magenta(agent.identity)}`);
          const skills = agent.card.skills.map((s) => s.id).join(", ");
          if (skills) console.log(`    Skills:  ${skills}`);
          console.log();
        }
      } catch {
        console.error(chalk.red("Error: Registry not available. Start it with: open-agent-bridge registry start"));
        process.exit(1);
      }
    });
}
