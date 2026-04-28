// open-agent-bridge ask <agent-id> <message>
import type { Command } from "commander";
import chalk from "chalk";
import { RegistryClient } from "../../client/registry-client.js";
import { A2AClient } from "../../client/a2a-client.js";

export function registerAskCommand(program: Command): void {
  program
    .command("ask <agent-id> <message>")
    .description("Send a message/task to a specific agent")
    .option("--skill <id>", "Specific skill to invoke")
    .option("--json", "Output as JSON")
    .option("--stream", "Stream the response")
    .option("--relay", "Send via registry WS relay instead of direct HTTP")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .action(async (agentId: string, message: string, options) => {
      const registry = new RegistryClient(options.registryUrl);
      const startTime = Date.now();

      try {
        const entry = await registry.getAgent(agentId).catch(async () => {
          // Try by name/project
          const all = await registry.listAgents();
          return all.find(
            (a) =>
              a.name.toLowerCase().includes(agentId.toLowerCase()) ||
              a.agentId.startsWith(agentId)
          );
        });

        if (!entry) {
          console.error(chalk.red(`Agent "${agentId}" not found`));
          process.exit(1);
        }

        console.error(
          chalk.cyan(`[→ SENDING] `) +
          chalk.white(`${entry.name} (${entry.agentId.slice(0, 8)})`) +
          (options.skill ? chalk.gray(` skill: ${options.skill}`) : "") +
          chalk.gray(` — "${message.slice(0, 60)}${message.length > 60 ? "..." : ""}"`)
        );

        // Try registry relay if --relay flag is set
        if (options.relay) {
          try {
            const client = new A2AClient(entry.url);
            const relayResult = await client.sendTaskViaRegistry(
              options.registryUrl,
              entry.agentId,
              {
                fromAgentId: "cli-" + Date.now(),
                message,
                skillId: options.skill,
              }
            );
            const elapsed = Date.now() - startTime;
            if (relayResult.delivered) {
              console.error(
                chalk.green(`[✓ RELAYED] `) +
                chalk.gray(`via ${relayResult.via} (${elapsed}ms)`)
              );
              console.error(
                chalk.yellow(`Note: WS relay delivers async. Use direct HTTP for sync response.`)
              );
              return;
            }
            console.error(chalk.yellow(`[!] WS relay not available, falling back to HTTP`));
          } catch {
            console.error(chalk.yellow(`[!] Relay failed, falling back to direct HTTP`));
          }
        }

        const client = new A2AClient(entry.url);
        const task = await client.sendTask({
          message: {
            role: "user",
            parts: [{ type: "text", text: message }],
          },
          metadata: options.skill ? { skillId: options.skill } : undefined,
        });

        const elapsed = Date.now() - startTime;
        console.error(
          chalk.green(`[← RESPONSE] `) +
          chalk.white(`${entry.name}`) +
          chalk.gray(` (${elapsed}ms)`) +
          chalk.gray(` task: ${task.id.slice(0, 8)} state: ${task.status.state}`)
        );

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
        const elapsed = Date.now() - startTime;
        console.error(
          chalk.red(`[✗ ERROR] `) +
          chalk.gray(`(${elapsed}ms) `) +
          chalk.red(`${err instanceof Error ? err.message : String(err)}`)
        );
        process.exit(1);
      }
    });
}
