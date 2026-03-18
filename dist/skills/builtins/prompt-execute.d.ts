import { z } from "zod";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";
declare const inputSchema: z.ZodObject<{
    template: z.ZodString;
    variables: z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>>;
    context: z.ZodOptional<z.ZodString>;
    instruction: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    template: string;
    variables: Record<string, string>;
    context?: string | undefined;
    instruction?: string | undefined;
}, {
    template: string;
    variables?: Record<string, string> | undefined;
    context?: string | undefined;
    instruction?: string | undefined;
}>;
declare const outputSchema: z.ZodObject<{
    prompt: z.ZodString;
    variablesUsed: z.ZodArray<z.ZodString, "many">;
    variablesMissing: z.ZodArray<z.ZodString, "many">;
    renderedLength: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    variablesUsed: string[];
    variablesMissing: string[];
    renderedLength: number;
}, {
    prompt: string;
    variablesUsed: string[];
    variablesMissing: string[];
    renderedLength: number;
}>;
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;
export declare class PromptExecuteSkill extends BaseSkill<Input, Output> {
    readonly id = "prompt-execute";
    readonly name = "Prompt Execute";
    readonly description: string;
    readonly tags: string[];
    readonly inputSchema: z.ZodObject<{
        template: z.ZodString;
        variables: z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>>;
        context: z.ZodOptional<z.ZodString>;
        instruction: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        template: string;
        variables: Record<string, string>;
        context?: string | undefined;
        instruction?: string | undefined;
    }, {
        template: string;
        variables?: Record<string, string> | undefined;
        context?: string | undefined;
        instruction?: string | undefined;
    }>;
    execute(input: Input, context: SkillContext): Promise<Output>;
}
export {};
//# sourceMappingURL=prompt-execute.d.ts.map