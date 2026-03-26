// Built-in skill: find API endpoints in a project
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";
import { DEFAULT_IGNORE } from "./shared-constants.js";

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
  endpoints: z.array(
    z.object({
      method: z.string(),
      path: z.string(),
      file: z.string(),
      line: z.number(),
      symbol: z.string().optional(),
      framework: z.string(),
    })
  ),
  count: z.number(),
  query: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

interface PatternDef {
  regex: RegExp;
  framework: string;
  extract: (match: RegExpMatchArray) => { method: string; path: string; symbol?: string } | null;
}

const PATTERNS: PatternDef[] = [
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

const FRONTEND_PATTERNS: PatternDef[] = [
  // axios: axios.get('/path'), axios.post('/path')
  {
    regex: /axios\.(get|post|put|patch|delete|head)\s*\(\s*['"`]([^'"`]+)['"`]/i,
    framework: "axios",
    extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
  // generic api client: api.get('/path'), api.post('/path'), client.get('/path')
  {
    regex: /(?:api|client|http)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i,
    framework: "api-client",
    extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
  // fetch with explicit method: fetch('/path', { method: 'POST' })
  {
    regex: /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{[^}]*method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i,
    framework: "fetch",
    extract: (m) => ({ method: m[2].toUpperCase(), path: m[1] }),
  },
  // fetch with no options (defaults to GET)
  {
    regex: /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]\s*[,)]/i,
    framework: "fetch",
    extract: (m) => ({ method: "GET", path: m[1] }),
  },
  // Vue $http: this.$http.get('/path')
  {
    regex: /\$http\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i,
    framework: "vue-http",
    extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
  // useFetch, useAsyncData (Nuxt): useFetch('/path')
  {
    regex: /use(?:Fetch|AsyncData|LazyFetch)\s*\(\s*['"`]([^'"`]+)['"`]/i,
    framework: "nuxt-fetch",
    extract: (m) => ({ method: "GET", path: m[1] }),
  },
];

const FRONTEND_GLOBS = ["**/*.ts", "**/*.js", "**/*.vue", "**/*.tsx", "**/*.jsx"];

const CODE_GLOBS: Record<string, string[]> = {
  auto: ["**/*.ts", "**/*.js", "**/*.py", "**/*.java", "**/*.go", "**/*.rs"],
  express: ["**/*.ts", "**/*.js", "**/*.mjs"],
  nestjs: ["**/*.controller.ts", "**/*.controller.js", "**/*.ts"],
  fastapi: ["**/*.py"],
  spring: ["**/*.java", "**/*.kt"],
  hono: ["**/*.ts", "**/*.js"],
  fastify: ["**/*.ts", "**/*.js"],
};

const PROJECT_TYPE_TO_GLOBS: Record<string, string[]> = {
  node: ["**/*.ts", "**/*.js", "**/*.mjs", "**/*.cjs"],
  python: ["**/*.py"],
  java: ["**/*.java", "**/*.kt"],
  go: ["**/*.go"],
  // Note: rust omitted — no Rust route patterns defined
};

export class EndpointFindSkill extends BaseSkill<Input, Output> {
  readonly id = "endpoint-find";
  readonly name = "Endpoint Finder";
  readonly description =
    "Find API endpoints defined in the project (backends: Express, NestJS, FastAPI, Spring, Gin) or API calls consumed by frontend projects (axios, fetch, api client patterns).";
  readonly tags = ["search", "endpoints", "api", "routes", "controllers"];
  readonly inputSchema = inputSchema;

  async execute(input: Input, context: SkillContext): Promise<Output> {
    const root = input.rootDir ?? context.projectPath;
    const framework = input.framework ?? "auto";
    const queryLower = input.query?.toLowerCase();

    const isFrontend = context.projectInfo?.category === "frontend" ||
                       context.projectInfo?.category === "fullstack";

    let patterns: PatternDef[];
    if (framework !== "auto") {
      patterns = PATTERNS; // explicit framework always uses backend patterns
    } else if (context.projectInfo?.category === "fullstack") {
      patterns = [...PATTERNS, ...FRONTEND_PATTERNS]; // fullstack: scan both
    } else if (isFrontend) {
      patterns = FRONTEND_PATTERNS; // pure frontend: only consumption patterns
    } else {
      patterns = PATTERNS; // backend or unknown
    }
    let globs: string[];
    if (isFrontend && framework === "auto") {
      globs = FRONTEND_GLOBS;
    } else if (framework === "auto" && context.projectInfo?.type) {
      // Narrow by project type to avoid scanning irrelevant file types
      globs = PROJECT_TYPE_TO_GLOBS[context.projectInfo.type] ?? CODE_GLOBS.auto;
    } else {
      globs = CODE_GLOBS[framework] ?? CODE_GLOBS.auto;
    }

    context.log("info", `Finding ${framework} endpoints in ${root}${isFrontend ? " (frontend mode)" : ""}`);

    const allFiles: string[] = [];
    for (const pattern of globs) {
      const found = await glob(pattern, { cwd: root, ignore: [...DEFAULT_IGNORE], nodir: true });
      allFiles.push(...found);
    }

    // Deduplicate
    const files = [...new Set(allFiles)];
    const endpoints: Output["endpoints"] = [];

    for (const relPath of files) {
      let content: string;
      try {
        content = await readFile(`${root}/${relPath}`, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of patterns) {
          const match = line.match(pattern.regex);
          if (!match) continue;

          const extracted = pattern.extract(match);
          if (!extracted) continue;

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
            if (!haystack.includes(queryLower)) continue;
          }

          endpoints.push(endpoint);
        }
      }
    }

    context.log("info", `Found ${endpoints.length} endpoints`);
    return { endpoints, count: endpoints.length, query: input.query };
  }
}
