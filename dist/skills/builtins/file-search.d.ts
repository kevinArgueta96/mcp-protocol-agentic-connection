import { z } from "zod";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";
declare const inputSchema: z.ZodObject<{
    pattern: z.ZodString;
    rootDir: z.ZodOptional<z.ZodString>;
    ignore: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    pattern: string;
    ignore: string[];
    limit: number;
    rootDir?: string | undefined;
}, {
    pattern: string;
    rootDir?: string | undefined;
    ignore?: string[] | undefined;
    limit?: number | undefined;
}>;
declare const outputSchema: z.ZodObject<{
    files: z.ZodArray<z.ZodString, "many">;
    count: z.ZodNumber;
    truncated: z.ZodBoolean;
    rootDir: z.ZodString;
}, "strip", z.ZodTypeAny, {
    rootDir: string;
    files: string[];
    count: number;
    truncated: boolean;
}, {
    rootDir: string;
    files: string[];
    count: number;
    truncated: boolean;
}>;
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;
export declare class FileSearchSkill extends BaseSkill<Input, Output> {
    readonly id = "file-search";
    readonly name = "File Search";
    readonly description = "Search for files by glob pattern in the project";
    readonly tags: string[];
    readonly inputSchema: z.ZodObject<{
        pattern: z.ZodString;
        rootDir: z.ZodOptional<z.ZodString>;
        ignore: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
        limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    }, "strip", z.ZodTypeAny, {
        pattern: string;
        ignore: string[];
        limit: number;
        rootDir?: string | undefined;
    }, {
        pattern: string;
        rootDir?: string | undefined;
        ignore?: string[] | undefined;
        limit?: number | undefined;
    }>;
    execute(input: Input, context: SkillContext): Promise<Output>;
}
export {};
//# sourceMappingURL=file-search.d.ts.map