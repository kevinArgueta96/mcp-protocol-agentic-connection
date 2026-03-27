// Built-in skill: search text/patterns in code files
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";
import { DEFAULT_IGNORE } from "./shared-constants.js";

const PROJECT_TYPE_GLOBS: Record<string, string> = {
  node: "**/*.{ts,js,mjs,cjs,json,vue,tsx,jsx}",
  python: "**/*.{py,pyi,toml,cfg,ini}",
  java: "**/*.{java,kt,xml,properties,yaml,yml}",
  go: "**/*.{go,mod,sum}",
  rust: "**/*.{rs,toml}",
};

const inputSchema = z.object({
  query: z.string().describe("Text or regex pattern to search"),
  fileGlob: z
    .string()
    .optional()
    .describe("Limit search to files matching this glob"),
  rootDir: z.string().optional().describe("Root directory to search"),
  maxResults: z.number().optional().default(50).describe("Maximum number of results"),
  caseSensitive: z.boolean().optional().default(false),
});

const outputSchema = z.object({
  matches: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      content: z.string(),
    })
  ),
  count: z.number(),
  truncated: z.boolean(),
  query: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

const IGNORE = [...DEFAULT_IGNORE, "**/*.lock"];
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2",
  ".ttf", ".eot", ".pdf", ".zip", ".tar", ".gz", ".bin", ".exe",
]);

function isBinary(filePath: string): boolean {
  const ext = "." + filePath.split(".").pop()?.toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export class CodeQuerySkill extends BaseSkill<Input, Output> {
  readonly id = "code-query";
  readonly name = "Code Query";
  readonly description = "Search for text or patterns within project code files";
  readonly tags = ["search", "code", "grep", "query"];
  readonly inputSchema = inputSchema;

  async execute(input: Input, context: SkillContext): Promise<Output> {
    const root = input.rootDir ?? context.projectPath;
    const maxResults = input.maxResults ?? 50;
    const flags = input.caseSensitive ? "" : "i";

    // fileGlob is undefined when caller didn't specify → apply project-type narrowing
    // fileGlob is a string when caller specified → respect caller's choice
    const callerGlob = input.fileGlob;
    const effectiveGlob = (callerGlob == null && context.projectInfo?.type)
      ? (PROJECT_TYPE_GLOBS[context.projectInfo.type] ?? "**/*")
      : (callerGlob ?? "**/*");

    context.log("info", `Searching code for "${input.query}" in ${root}`);

    let regex: RegExp;
    try {
      regex = new RegExp(input.query, flags);
    } catch {
      // Treat as literal string if invalid regex
      const escaped = input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regex = new RegExp(escaped, flags);
    }

    const files = await glob(effectiveGlob, { cwd: root, ignore: IGNORE, nodir: true });
    const matches: Output["matches"] = [];
    let truncated = false;

    outer: for (const relPath of files) {
      if (isBinary(relPath)) continue;

      let content: string;
      try {
        content = await readFile(`${root}/${relPath}`, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({ file: relPath, line: i + 1, content: lines[i].trim() });
          if (matches.length >= maxResults) {
            truncated = true;
            break outer;
          }
        }
      }
    }

    context.log("info", `Found ${matches.length} matches${truncated ? " (truncated)" : ""}`);
    return { matches, count: matches.length, truncated, query: input.query };
  }
}
