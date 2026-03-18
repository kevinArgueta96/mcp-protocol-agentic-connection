// Built-in skill: render a prompt template and return structured result
import { z } from "zod";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";

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

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

const PLACEHOLDER_REGEX = /\{\{(\w+)\}\}/g;

export class PromptExecuteSkill extends BaseSkill<Input, Output> {
  readonly id = "prompt-execute";
  readonly name = "Prompt Execute";
  readonly description =
    "Render a prompt template with variables for injection into an LLM agent. " +
    "Returns the rendered prompt so the receiving agent can act on it.";
  readonly tags = ["prompt", "template", "llm", "inject", "delegate"];
  readonly inputSchema = inputSchema;

  async execute(input: Input, context: SkillContext): Promise<Output> {
    context.log("info", `Rendering prompt template (${input.template.length} chars)`);

    const variables = input.variables ?? {};
    const placeholders = [...input.template.matchAll(PLACEHOLDER_REGEX)].map((m) => m[1]);
    const variablesUsed: string[] = [];
    const variablesMissing: string[] = [];

    let rendered = input.template.replace(PLACEHOLDER_REGEX, (_, name: string) => {
      if (name in variables) {
        variablesUsed.push(name);
        return variables[name];
      }
      variablesMissing.push(name);
      return `{{${name}}}`; // Keep unresolved placeholders visible
    });

    // Prepend context and instruction if provided
    const parts: string[] = [];
    if (input.context) parts.push(`Context:\n${input.context}`);
    if (input.instruction) parts.push(`Instruction: ${input.instruction}`);
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
