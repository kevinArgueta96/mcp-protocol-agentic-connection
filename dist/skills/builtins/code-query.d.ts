import { z } from "zod";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";
declare const inputSchema: z.ZodObject<{
    query: z.ZodString;
    fileGlob: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    rootDir: z.ZodOptional<z.ZodString>;
    maxResults: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    caseSensitive: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    query: string;
    fileGlob: string;
    maxResults: number;
    caseSensitive: boolean;
    rootDir?: string | undefined;
}, {
    query: string;
    rootDir?: string | undefined;
    fileGlob?: string | undefined;
    maxResults?: number | undefined;
    caseSensitive?: boolean | undefined;
}>;
declare const outputSchema: z.ZodObject<{
    matches: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        content: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        file: string;
        line: number;
        content: string;
    }, {
        file: string;
        line: number;
        content: string;
    }>, "many">;
    count: z.ZodNumber;
    truncated: z.ZodBoolean;
    query: z.ZodString;
}, "strip", z.ZodTypeAny, {
    query: string;
    count: number;
    truncated: boolean;
    matches: {
        file: string;
        line: number;
        content: string;
    }[];
}, {
    query: string;
    count: number;
    truncated: boolean;
    matches: {
        file: string;
        line: number;
        content: string;
    }[];
}>;
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;
export declare class CodeQuerySkill extends BaseSkill<Input, Output> {
    readonly id = "code-query";
    readonly name = "Code Query";
    readonly description = "Search for text or patterns within project code files";
    readonly tags: string[];
    readonly inputSchema: z.ZodObject<{
        query: z.ZodString;
        fileGlob: z.ZodDefault<z.ZodOptional<z.ZodString>>;
        rootDir: z.ZodOptional<z.ZodString>;
        maxResults: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
        caseSensitive: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    }, "strip", z.ZodTypeAny, {
        query: string;
        fileGlob: string;
        maxResults: number;
        caseSensitive: boolean;
        rootDir?: string | undefined;
    }, {
        query: string;
        rootDir?: string | undefined;
        fileGlob?: string | undefined;
        maxResults?: number | undefined;
        caseSensitive?: boolean | undefined;
    }>;
    execute(input: Input, context: SkillContext): Promise<Output>;
}
export {};
//# sourceMappingURL=code-query.d.ts.map