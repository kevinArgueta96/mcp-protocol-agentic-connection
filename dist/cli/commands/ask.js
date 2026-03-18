import chalk from "chalk";
import { RegistryClient } from "../../client/registry-client.js";
import { A2AClient } from "../../client/a2a-client.js";
export function registerAskCommand(program) {
    program
        .command("ask <agent-id> <message>")
        .description("Send a message/task to a specific agent")
        .option("--skill <id>", "Specific skill to invoke")
        .option("--json", "Output as JSON")
        .option("--stream", "Stream the response")
        .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
        .action(async (agentId, message, options) => {
        const registry = new RegistryClient(options.registryUrl);
        try {
            const entry = await registry.getAgent(agentId).catch(async () => {
                // Try by name/project
                const all = await registry.listAgents();
                return all.find((a) => a.name.toLowerCase().includes(agentId.toLowerCase()) ||
                    a.agentId.startsWith(agentId));
            });
            if (!entry) {
                console.error(chalk.red(`Agent "${agentId}" not found`));
                process.exit(1);
            }
            const client = new A2AClient(entry.url);
            const task = await client.sendTask({
                message: {
                    role: "user",
                    parts: [{ type: "text", text: message }],
                },
                metadata: options.skill ? { skillId: options.skill } : undefined,
            });
            if (options.json) {
                console.log(JSON.stringify(task, null, 2));
                return;
            }
            const artifact = task.artifacts[0];
            if (artifact) {
                for (const part of artifact.parts) {
                    if (part.type === "text")
                        console.log(part.text);
                    else if (part.type === "data")
                        console.log(JSON.stringify(part.data, null, 2));
                }
            }
            else {
                console.log(chalk.yellow(`Task ${task.id} — state: ${task.status.state}`));
            }
        }
        catch (err) {
            console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
            process.exit(1);
        }
    });
}
//# sourceMappingURL=ask.js.map