// Built-in skill: execute complex tasks using Claude Code CLI subprocess
import { z } from "zod";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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

// Resolve the claude CLI path once at module load
// Checks known locations before falling back to PATH lookup
function resolveClaudePath(): string {
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Try PATH resolution
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  } catch {
    return "claude"; // let the OS find it
  }
}

const CLAUDE_PATH = resolveClaudePath();

export class ClaudeExecuteSkill extends BaseSkill<Input, Output> {
  readonly id = "claude-execute";
  readonly name = "Claude Code Execute";
  readonly description =
    "Execute complex code tasks using Claude Code AI (analysis, refactoring, generation, review)";
  readonly tags = ["ai", "code", "analysis", "modification", "review"];
  readonly inputSchema = inputSchema;

  async execute(input: Input, context: SkillContext): Promise<Output> {
    const tools = input.allowedTools ?? ["Read", "Glob", "Grep", "Bash"];
    const claudePath = CLAUDE_PATH;

    context.log("info", `Claude Code executing: "${input.prompt.slice(0, 80)}..."`);

    const args = [
      "-p", input.prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--allowedTools", tools.join(","),
    ];

    return new Promise<Output>((resolve, reject) => {
      const proc = spawn(claudePath, args, {
        cwd: context.projectPath,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let resultText = "";
      let sessionId: string | null = null;
      let cost = 0;
      let stderrOutput = "";
      let buffer = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as Record<string, unknown>;
            if (typeof msg.session_id === "string") sessionId = msg.session_id;
            if (msg.type === "result" && typeof msg.result === "string") {
              resultText = msg.result;
              if (typeof msg.total_cost_usd === "number") cost = msg.total_cost_usd;
            }
          } catch {
            // Ignore non-JSON lines
          }
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0 && !resultText) {
          const errSummary = stderrOutput.slice(0, 200);
          reject(new Error(`Claude Code exited with code ${code}: ${errSummary}`));
          return;
        }
        context.log("info", `Claude Code completed. Cost: $${cost.toFixed(4)}`);
        resolve({ text: resultText, sessionId, cost });
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });
    });
  }
}
