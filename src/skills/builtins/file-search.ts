// Built-in skill: search files by glob pattern
import { z } from "zod";
import { glob } from "glob";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";
import { DEFAULT_IGNORE } from "./shared-constants.js";

const inputSchema = z.object({
  pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/**/*.json')"),
  rootDir: z.string().optional().describe("Root directory (defaults to project root)"),
  ignore: z
    .array(z.string())
    .optional()
    .default([...DEFAULT_IGNORE])
    .describe("Patterns to ignore"),
  limit: z.number().optional().default(100).describe("Max number of results"),
});

const outputSchema = z.object({
  files: z.array(z.string()),
  count: z.number(),
  truncated: z.boolean(),
  rootDir: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

export class FileSearchSkill extends BaseSkill<Input, Output> {
  readonly id = "file-search";
  readonly name = "File Search";
  readonly description = "Search for files by glob pattern in the project";
  readonly tags = ["search", "files", "glob"];
  readonly inputSchema = inputSchema;

  async execute(input: Input, context: SkillContext): Promise<Output> {
    const root = input.rootDir ?? context.projectPath;
    const ignore = input.ignore;
    const limit = input.limit ?? 100;

    context.log("info", `Searching for "${input.pattern}" in ${root}`);

    const matches = await glob(input.pattern, {
      cwd: root,
      ignore,
      nodir: true,
    });

    const truncated = matches.length > limit;
    const files = matches.slice(0, limit);

    context.log("info", `Found ${matches.length} files${truncated ? ` (truncated to ${limit})` : ""}`);

    return {
      files,
      count: matches.length,
      truncated,
      rootDir: root,
    };
  }
}
