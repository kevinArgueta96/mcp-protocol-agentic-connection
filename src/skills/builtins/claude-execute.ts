// Built-in skill: execute complex tasks using Claude Code SDK
import { z } from "zod";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";

const inputSchema = z.object({
  prompt: z.string().describe("The task or question for Claude Code"),
  allowedTools: z
    .array(z.string())
    .optional()
    .describe("Allowed Claude Code tools (default: Read, Glob, Grep, Bash)"),
});

const outputSchema = z.object({
  text: z.string(),
  sessionId: z.string().nullable(),
  cost: z.number(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

export class ClaudeExecuteSkill extends BaseSkill<Input, Output> {
  readonly id = "claude-execute";
  readonly name = "Claude Code Execute";
  readonly description =
    "Execute complex code tasks using Claude Code AI (analysis, refactoring, generation, review)";
  readonly tags = ["ai", "code", "analysis", "modification", "review"];
  readonly inputSchema = inputSchema;

  // Session persistence: projectPath → claude sessionId
  private sessions = new Map<string, string>();

  async execute(input: Input, context: SkillContext): Promise<Output> {
    // @ts-expect-error — @anthropic-ai/claude-code has no TypeScript module exports
    const { query } = await import("@anthropic-ai/claude-code");

    const existingSession = this.sessions.get(context.projectPath);

    context.log("info", `Claude Code executing: "${input.prompt.slice(0, 80)}..."`);

    const messages = query({
      prompt: input.prompt,
      options: {
        ...(existingSession ? { resume: existingSession } : {}),
        cwd: context.projectPath,
        allowedTools: input.allowedTools ?? ["Read", "Glob", "Grep", "Bash"],
      },
    });

    let resultText = "";
    let sessionId: string | null = null;
    let cost = 0;

    for await (const msg of messages) {
      sessionId = msg.session_id ?? sessionId;
      if (msg.type === "result" && "result" in msg) {
        resultText = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result);
        if ("total_cost_usd" in msg && typeof msg.total_cost_usd === "number") {
          cost = msg.total_cost_usd;
        }
        break;
      }
    }

    if (sessionId) this.sessions.set(context.projectPath, sessionId);

    context.log("info", `Claude Code completed. Cost: $${cost.toFixed(4)}`);

    return { text: resultText, sessionId, cost };
  }
}
