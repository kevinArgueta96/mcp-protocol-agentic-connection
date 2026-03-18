import chalk from "chalk";
import { RegistryClient } from "../../client/registry-client.js";
export function registerFindCommand(program) {
    program
        .command("find <query>")
        .description("Find agents by skill tag, project name, or path")
        .option("--json", "Output as JSON")
        .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
        .action(async (query, options) => {
        const registry = new RegistryClient(options.registryUrl);
        try {
            // Try both skill and project search
            const [bySkill, byProject] = await Promise.all([
                registry.listAgents({ skill: query }),
                registry.listAgents({ project: query }),
            ]);
            // Deduplicate
            const seen = new Set();
            const results = [...bySkill, ...byProject].filter((a) => {
                if (seen.has(a.agentId))
                    return false;
                seen.add(a.agentId);
                return true;
            });
            if (options.json) {
                console.log(JSON.stringify(results, null, 2));
                return;
            }
            if (results.length === 0) {
                console.log(chalk.yellow(`No agents found matching "${query}"`));
                return;
            }
            console.log(chalk.bold(`\nAgents matching "${query}" (${results.length})\n`));
            for (const agent of results) {
                console.log(`  ${chalk.cyan(agent.name)}  ${agent.agentId.slice(0, 8)}...`);
                console.log(`    Path:   ${agent.projectPath}`);
                console.log(`    Skills: ${agent.card.skills.map((s) => s.id).join(", ")}`);
            }
        }
        catch {
            console.error(chalk.red("Registry not available"));
            process.exit(1);
        }
    });
}
//# sourceMappingURL=find.js.map