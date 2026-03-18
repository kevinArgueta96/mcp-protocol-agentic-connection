import chalk from "chalk";
import { RegistryClient } from "../../client/registry-client.js";
import { A2AClient } from "../../client/a2a-client.js";
export function registerBroadcastCommand(program) {
    program
        .command("broadcast <message>")
        .description("Broadcast a message to all healthy registered agents")
        .option("--json", "Output as JSON")
        .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
        .action(async (message, options) => {
        const registry = new RegistryClient(options.registryUrl);
        try {
            const agents = await registry.listAgents({ healthy: true });
            if (agents.length === 0) {
                console.log(chalk.yellow("No healthy agents to broadcast to"));
                return;
            }
            if (!options.json) {
                console.log(chalk.dim(`Broadcasting to ${agents.length} agents...`));
            }
            const results = await Promise.allSettled(agents.map(async (agent) => {
                const client = new A2AClient(agent.url);
                const task = await client.sendTask({
                    message: { role: "user", parts: [{ type: "text", text: message }] },
                });
                return { agentId: agent.agentId, name: agent.name, task };
            }));
            const formatted = results.map((r, i) => ({
                agent: agents[i].name,
                agentId: agents[i].agentId,
                status: r.status,
                result: r.status === "fulfilled" ? r.value.task : undefined,
                error: r.status === "rejected" ? String(r.reason) : undefined,
            }));
            if (options.json) {
                console.log(JSON.stringify(formatted, null, 2));
                return;
            }
            for (const r of formatted) {
                const icon = r.status === "fulfilled" ? chalk.green("✓") : chalk.red("✗");
                console.log(`${icon} ${chalk.cyan(r.agent)}`);
            }
        }
        catch {
            console.error(chalk.red("Registry not available"));
            process.exit(1);
        }
    });
}
//# sourceMappingURL=broadcast.js.map