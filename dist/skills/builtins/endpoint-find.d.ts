import { z } from "zod";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";
declare const inputSchema: z.ZodObject<{
    rootDir: z.ZodOptional<z.ZodString>;
    framework: z.ZodDefault<z.ZodOptional<z.ZodEnum<["auto", "express", "nestjs", "fastapi", "spring", "hono", "fastify"]>>>;
    query: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    framework: "auto" | "express" | "nestjs" | "fastapi" | "spring" | "hono" | "fastify";
    rootDir?: string | undefined;
    query?: string | undefined;
}, {
    rootDir?: string | undefined;
    query?: string | undefined;
    framework?: "auto" | "express" | "nestjs" | "fastapi" | "spring" | "hono" | "fastify" | undefined;
}>;
declare const outputSchema: z.ZodObject<{
    endpoints: z.ZodArray<z.ZodObject<{
        method: z.ZodString;
        path: z.ZodString;
        file: z.ZodString;
        line: z.ZodNumber;
        symbol: z.ZodOptional<z.ZodString>;
        framework: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        file: string;
        path: string;
        framework: string;
        method: string;
        line: number;
        symbol?: string | undefined;
    }, {
        file: string;
        path: string;
        framework: string;
        method: string;
        line: number;
        symbol?: string | undefined;
    }>, "many">;
    count: z.ZodNumber;
    query: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    count: number;
    endpoints: {
        file: string;
        path: string;
        framework: string;
        method: string;
        line: number;
        symbol?: string | undefined;
    }[];
    query?: string | undefined;
}, {
    count: number;
    endpoints: {
        file: string;
        path: string;
        framework: string;
        method: string;
        line: number;
        symbol?: string | undefined;
    }[];
    query?: string | undefined;
}>;
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;
export declare class EndpointFindSkill extends BaseSkill<Input, Output> {
    readonly id = "endpoint-find";
    readonly name = "Endpoint Finder";
    readonly description = "Find API endpoints (routes/controllers) defined in the project. Supports Express, NestJS, FastAPI, Spring, Gin.";
    readonly tags: string[];
    readonly inputSchema: z.ZodObject<{
        rootDir: z.ZodOptional<z.ZodString>;
        framework: z.ZodDefault<z.ZodOptional<z.ZodEnum<["auto", "express", "nestjs", "fastapi", "spring", "hono", "fastify"]>>>;
        query: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        framework: "auto" | "express" | "nestjs" | "fastapi" | "spring" | "hono" | "fastify";
        rootDir?: string | undefined;
        query?: string | undefined;
    }, {
        rootDir?: string | undefined;
        query?: string | undefined;
        framework?: "auto" | "express" | "nestjs" | "fastapi" | "spring" | "hono" | "fastify" | undefined;
    }>;
    execute(input: Input, context: SkillContext): Promise<Output>;
}
export {};
//# sourceMappingURL=endpoint-find.d.ts.map