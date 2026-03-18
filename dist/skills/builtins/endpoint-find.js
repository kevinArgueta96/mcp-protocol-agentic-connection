// Built-in skill: find API endpoints in a project
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { BaseSkill } from "../framework.js";
const inputSchema = z.object({
    rootDir: z.string().optional().describe("Root directory to scan"),
    framework: z
        .enum(["auto", "express", "nestjs", "fastapi", "spring", "hono", "fastify"])
        .optional()
        .default("auto")
        .describe("Framework hint"),
    query: z.string().optional().describe("Filter endpoints by path/method keyword"),
});
const outputSchema = z.object({
    endpoints: z.array(z.object({
        method: z.string(),
        path: z.string(),
        file: z.string(),
        line: z.number(),
        symbol: z.string().optional(),
        framework: z.string(),
    })),
    count: z.number(),
    query: z.string().optional(),
});
const PATTERNS = [
    // Express / Fastify / Hono: app.get('/path', ...) or router.post('/path', ...)
    {
        regex: /(?:app|router|server)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/i,
        framework: "express",
        extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
    },
    // NestJS decorators: @Get('/path'), @Post('/path'), etc.
    {
        regex: /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/,
        framework: "nestjs",
        extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] || "/" }),
    },
    // NestJS Controller: @Controller('/base')
    {
        regex: /@Controller\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/,
        framework: "nestjs",
        extract: (m) => ({ method: "CONTROLLER", path: m[1] }),
    },
    // FastAPI: @app.get('/path'), @router.post('/path')
    {
        regex: /@(?:app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/i,
        framework: "fastapi",
        extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
    },
    // Spring: @GetMapping("/path"), @PostMapping("/path"), @RequestMapping(value="/path")
    {
        regex: /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*(?:\(\s*(?:value\s*=\s*)?['"`]([^'"`]*)['"`])?/,
        framework: "spring",
        extract: (m) => ({
            method: m[1].replace("Mapping", "").replace("Request", "ANY").toUpperCase(),
            path: m[2] ?? "/",
        }),
    },
    // Go Gin / Chi: r.GET("/path", ...), r.POST("/path", ...)
    {
        regex: /[rR](?:outer|\.)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Handle)\s*\(\s*"([^"]+)"/,
        framework: "go-gin",
        extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
    },
];
const CODE_GLOBS = {
    auto: ["**/*.ts", "**/*.js", "**/*.py", "**/*.java", "**/*.go", "**/*.rs"],
    express: ["**/*.ts", "**/*.js", "**/*.mjs"],
    nestjs: ["**/*.controller.ts", "**/*.controller.js", "**/*.ts"],
    fastapi: ["**/*.py"],
    spring: ["**/*.java", "**/*.kt"],
    hono: ["**/*.ts", "**/*.js"],
    fastify: ["**/*.ts", "**/*.js"],
};
const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**"];
export class EndpointFindSkill extends BaseSkill {
    id = "endpoint-find";
    name = "Endpoint Finder";
    description = "Find API endpoints (routes/controllers) defined in the project. Supports Express, NestJS, FastAPI, Spring, Gin.";
    tags = ["search", "endpoints", "api", "routes", "controllers"];
    inputSchema = inputSchema;
    async execute(input, context) {
        const root = input.rootDir ?? context.projectPath;
        const framework = input.framework ?? "auto";
        const queryLower = input.query?.toLowerCase();
        context.log("info", `Finding ${framework} endpoints in ${root}`);
        const globs = CODE_GLOBS[framework] ?? CODE_GLOBS.auto;
        const allFiles = [];
        for (const pattern of globs) {
            const found = await glob(pattern, { cwd: root, ignore: IGNORE, nodir: true });
            allFiles.push(...found);
        }
        // Deduplicate
        const files = [...new Set(allFiles)];
        const endpoints = [];
        for (const relPath of files) {
            let content;
            try {
                content = await readFile(`${root}/${relPath}`, "utf-8");
            }
            catch {
                continue;
            }
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                for (const pattern of PATTERNS) {
                    const match = line.match(pattern.regex);
                    if (!match)
                        continue;
                    const extracted = pattern.extract(match);
                    if (!extracted)
                        continue;
                    const endpoint = {
                        method: extracted.method,
                        path: extracted.path,
                        file: relPath,
                        line: i + 1,
                        symbol: extracted.symbol,
                        framework: pattern.framework,
                    };
                    // Apply query filter if provided
                    if (queryLower) {
                        const haystack = `${endpoint.method} ${endpoint.path} ${relPath}`.toLowerCase();
                        if (!haystack.includes(queryLower))
                            continue;
                    }
                    endpoints.push(endpoint);
                }
            }
        }
        context.log("info", `Found ${endpoints.length} endpoints`);
        return { endpoints, count: endpoints.length, query: input.query };
    }
}
//# sourceMappingURL=endpoint-find.js.map