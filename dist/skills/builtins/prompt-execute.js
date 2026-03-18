// Built-in skill: render a prompt template and return structured result
import { z } from "zod";
import { BaseSkill } from "../framework.js";
const inputSchema = z.object({
    template: z.string().describe("Prompt template with {{variable}} placeholders"),
    variables: z.record(z.string()).optional().default({}).describe("Variables to inject"),
    context: z.string().optional().describe("Additional context to prepend"),
    instruction: z
        .string()
        .optional()
        .describe("What the agent receiving this prompt should do with it"),
});
const outputSchema = z.object({
    prompt: z.string(),
    variablesUsed: z.array(z.string()),
    variablesMissing: z.array(z.string()),
    renderedLength: z.number(),
});
const PLACEHOLDER_REGEX = /\{\{(\w+)\}\}/g;
export class PromptExecuteSkill extends BaseSkill {
    id = "prompt-execute";
    name = "Prompt Execute";
    description = "Render a prompt template with variables for injection into an LLM agent. " +
        "Returns the rendered prompt so the receiving agent can act on it.";
    tags = ["prompt", "template", "llm", "inject", "delegate"];
    inputSchema = inputSchema;
    async execute(input, context) {
        context.log("info", `Rendering prompt template (${input.template.length} chars)`);
        const variables = input.variables ?? {};
        const placeholders = [...input.template.matchAll(PLACEHOLDER_REGEX)].map((m) => m[1]);
        const variablesUsed = [];
        const variablesMissing = [];
        let rendered = input.template.replace(PLACEHOLDER_REGEX, (_, name) => {
            if (name in variables) {
                variablesUsed.push(name);
                return variables[name];
            }
            variablesMissing.push(name);
            return `{{${name}}}`; // Keep unresolved placeholders visible
        });
        // Prepend context and instruction if provided
        const parts = [];
        if (input.context)
            parts.push(`Context:\n${input.context}`);
        if (input.instruction)
            parts.push(`Instruction: ${input.instruction}`);
        parts.push(rendered);
        const finalPrompt = parts.join("\n\n");
        return {
            prompt: finalPrompt,
            variablesUsed,
            variablesMissing,
            renderedLength: finalPrompt.length,
        };
    }
}
//# sourceMappingURL=prompt-execute.js.map