import chalk from "chalk";
import { RegistryClient } from "../../client/registry-client.js";
import { A2AClient } from "../../client/a2a-client.js";
export function registerHealthCommand(program) {
    program
        .command("health [agent-id]")
        .description("Check health of agents (all or a specific one)")
        .option("--json", "Output as JSON")
        .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
        .action(async (agentId, options) => {
        const registry = new RegistryClient(options.registryUrl);
        try {
            const agents = agentId
                ? [await registry.getAgent(agentId)]
                : await registry.listAgents();
            const results = await Promise.all(agents.map(async (agent) => {
                try {
                    const client = new A2AClient(agent.url);
                    const health = await client.health();
                    return { ...agent, liveStatus: health.status, reachable: true };
                }
                catch {
                    return { ...agent, liveStatus: "unreachable", reachable: false };
                }
            }));
            if (options.json) {
                console.log(JSON.stringify(results, null, 2));
                return;
            }
            for (const r of results) {
                const icon = r.reachable ? chalk.green("✓") : chalk.red("✗");
                console.log(`${icon} ${chalk.cyan(r.name)} (${r.agentId.slice(0, 8)}...)`);
                console.log(`  Status: ${r.liveStatus}`);
                console.log(`  URL:    ${r.url}`);
            }
        }
        catch {
            console.error(chalk.red("Registry not available"));
            process.exit(1);
        }
    });
}
//# sourceMappingURL=health.js.map