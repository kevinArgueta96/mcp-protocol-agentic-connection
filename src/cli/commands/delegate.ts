// open-agent-bridge delegate <skill-id> <message> — find agent with skill and send task
import type { Command } from "commander";
import chalk from "chalk";
import { RegistryClient } from "../../client/registry-client.js";
import { A2AClient } from "../../client/a2a-client.js";

export function registerDelegateCommand(program: Command): void {
  program
    .command("delegate <skill-id> <message>")
    .description("Delegate a task to the best available agent that has the given skill")
    .option("--json", "Output as JSON")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .action(async (skillId: string, message: string, options) => {
      const registry = new RegistryClient(options.registryUrl);

      try {
        const agents = await registry.listAgents({ skill: skillId, healthy: true });

        if (agents.length === 0) {
          console.error(chalk.red(`No healthy agents with skill "${skillId}"`));
          process.exit(1);
        }

        const target = agents[0];
        if (!options.json) {
          console.log(chalk.dim(`Delegating to ${chalk.cyan(target.name)} (${skillId})...`));
        }

        const client = new A2AClient(target.url);
        const task = await client.sendTask({
          message: { role: "user", parts: [{ type: "text", text: message }] },
          metadata: { skillId },
        });

        if (options.json) {
          console.log(JSON.stringify(task, null, 2));
          return;
        }

        const artifact = task.artifacts[0];
        if (artifact) {
          for (const part of artifact.parts) {
            if (part.type === "text") console.log(part.text);
            else if (part.type === "data") console.log(JSON.stringify(part.data, null, 2));
          }
        } else {
          console.log(chalk.yellow(`Task ${task.id} — state: ${task.status.state}`));
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}
