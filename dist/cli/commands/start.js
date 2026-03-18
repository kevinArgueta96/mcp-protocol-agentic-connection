import chalk from "chalk";
import { AgentServer } from "../../agent/server.js";
import { RegistryServer } from "../../registry/server.js";
import { McpAgentBridge } from "../../mcp/adapter.js";
export function registerStartCommand(program) {
    program
        .command("start [path]")
        .description("Start an agent server for a project directory")
        .option("-p, --port <number>", "Port to listen on (default: auto from 5001)", parseInt)
        .option("--registry", "Start the registry server instead of an agent")
        .option("--mcp", "Start MCP adapter for Claude Code / Codex integration")
        .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
        .action(async (projectPath, options) => {
        if (options.registry) {
            const registry = new RegistryServer();
            await registry.start();
            console.log(chalk.green("✓") + " Registry started on http://localhost:4999");
            process.on("SIGINT", async () => {
                await registry.stop();
                process.exit(0);
            });
            return;
        }
        if (options.mcp) {
            const bridge = new McpAgentBridge({ registryUrl: options.registryUrl });
            await bridge.start("stdio");
            return;
        }
        const agent = new AgentServer({
            port: options.port,
            projectPath: projectPath ?? process.cwd(),
            registryUrl: options.registryUrl,
        });
        const result = await agent.start();
        console.log(chalk.green("✓") + ` Agent started`);
        console.log(`  ID:      ${chalk.cyan(result.agentId)}`);
        console.log(`  HTTP:    ${chalk.blue(result.url)}`);
        console.log(`  WS:      ${chalk.blue(result.wsUrl)}`);
        console.log(`  Project: ${result.card.name}`);
        console.log(`  Skills:  ${result.card.skills.map((s) => s.id).join(", ")}`);
        process.on("SIGINT", async () => {
            console.log("\n" + chalk.yellow("Shutting down..."));
            await agent.stop();
            process.exit(0);
        });
    });
}
//# sourceMappingURL=start.js.map