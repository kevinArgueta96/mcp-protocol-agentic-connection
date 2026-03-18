// Built-in skill: search text/patterns in code files
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { BaseSkill } from "../framework.js";
const inputSchema = z.object({
    query: z.string().describe("Text or regex pattern to search"),
    fileGlob: z
        .string()
        .optional()
        .default("**/*")
        .describe("Limit search to files matching this glob"),
    rootDir: z.string().optional().describe("Root directory to search"),
    maxResults: z.number().optional().default(50).describe("Maximum number of results"),
    caseSensitive: z.boolean().optional().default(false),
});
const outputSchema = z.object({
    matches: z.array(z.object({
        file: z.string(),
        line: z.number(),
        content: z.string(),
    })),
    count: z.number(),
    truncated: z.boolean(),
    query: z.string(),
});
const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**", "**/*.lock"];
const BINARY_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2",
    ".ttf", ".eot", ".pdf", ".zip", ".tar", ".gz", ".bin", ".exe",
]);
function isBinary(filePath) {
    const ext = "." + filePath.split(".").pop()?.toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}
export class CodeQuerySkill extends BaseSkill {
    id = "code-query";
    name = "Code Query";
    description = "Search for text or patterns within project code files";
    tags = ["search", "code", "grep", "query"];
    inputSchema = inputSchema;
    async execute(input, context) {
        const root = input.rootDir ?? context.projectPath;
        const maxResults = input.maxResults ?? 50;
        const fileGlob = input.fileGlob ?? "**/*";
        const flags = input.caseSensitive ? "" : "i";
        context.log("info", `Searching code for "${input.query}" in ${root}`);
        let regex;
        try {
            regex = new RegExp(input.query, flags);
        }
        catch {
            // Treat as literal string if invalid regex
            const escaped = input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            regex = new RegExp(escaped, flags);
        }
        const files = await glob(fileGlob, { cwd: root, ignore: IGNORE, nodir: true });
        const matches = [];
        let truncated = false;
        outer: for (const relPath of files) {
            if (isBinary(relPath))
                continue;
            let content;
            try {
                content = await readFile(`${root}/${relPath}`, "utf-8");
            }
            catch {
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
//# sourceMappingURL=code-query.js.map