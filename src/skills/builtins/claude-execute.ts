// Built-in skill: execute code tasks via Claude
//
// Strategy (in order):
//   1. ANTHROPIC_API_KEY is set → call Anthropic REST API directly (no subprocess)
//   2. OAuth credentials exist  → use persistent ClaudeProcess singleton
//      (--strict-mcp-config + CLAUDE_CODE_SIMPLE=1 → no cascade spawning)
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { globSync } from "glob";
import Anthropic from "@anthropic-ai/sdk";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";
import { ClaudeProcess } from "./claude-process.js";

// ── Schemas ────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  prompt: z.string().describe("The task or question for Claude"),
  allowedTools: z
    .array(z.string())
    .optional()
    .describe("Allowed tools: Read, Glob, Grep (default: all three)"),
});

type Input = z.infer<typeof inputSchema>;
export interface Output { text: string; sessionId: string | null; cost: number; }

// ── Persistent process path ──────────────────────────────────────────────────

async function sendToClaudeProcess(input: Input, context: SkillContext): Promise<Output> {
  const tools = input.allowedTools ?? ["Read", "Glob", "Grep"];
  const proc = ClaudeProcess.getInstance();

  if (!proc.isAlive()) {
    proc.start(context.projectPath, tools);
  }

  const result = await proc.send(input.prompt, 300_000);
  context.log("info", `claude-execute (persistent) done. Cost: $${result.cost.toFixed(4)}`);
  return result;
}

// ── SDK path ───────────────────────────────────────────────────────────────
// Used only when ANTHROPIC_API_KEY is available (sk-ant-api03-).
// OAuth tokens (sk-ant-oat01-) are rejected by the REST API.

const SDK_TOOLS: Anthropic.Tool[] = [
  {
    name: "Read",
    description: "Read a file from the project directory",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string", description: "Relative path" } },
      required: ["file_path"],
    },
  },
  {
    name: "Glob",
    description: "Find files matching a glob pattern",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string", description: "e.g. src/**/*.ts" } },
      required: ["pattern"],
    },
  },
  {
    name: "Grep",
    description: "Search for a regex pattern in a file",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Relative file path" },
      },
      required: ["pattern", "path"],
    },
  },
];

function runTool(name: string, inp: Record<string, string>, cwd: string): string {
  try {
    switch (name) {
      case "Read": {
        const abs = resolve(cwd, inp.file_path);
        return existsSync(abs) ? readFileSync(abs, "utf8") : `Error: not found: ${inp.file_path}`;
      }
      case "Glob": {
        const matches = globSync(inp.pattern, { cwd, nodir: false }).slice(0, 200);
        return matches.length ? matches.join("\n") : "(no matches)";
      }
      case "Grep": {
        const abs = resolve(cwd, inp.path);
        if (!existsSync(abs)) return `Error: not found: ${inp.path}`;
        const re = new RegExp(inp.pattern, "gm");
        const lines: string[] = [];
        readFileSync(abs, "utf8").split("\n").forEach((line, i) => {
          if (re.test(line)) lines.push(`${i + 1}: ${line}`);
          re.lastIndex = 0;
        });
        return lines.length ? lines.join("\n") : "(no matches)";
      }
      default: return `Unknown tool: ${name}`;
    }
  } catch (e) { return `Error: ${(e as Error).message}`; }
}

async function callSdk(input: Input, context: SkillContext): Promise<Output> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const allowedTools = new Set(input.allowedTools ?? ["Read", "Glob", "Grep"]);
  const tools = SDK_TOOLS.filter((t) => allowedTools.has(t.name));
  const cwd = context.projectPath;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: input.prompt },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  const MAX_TURNS = 10;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8096,
      tools: tools.length ? tools : undefined,
      messages,
      system: `You are a code assistant. Working directory: ${cwd}. Be concise.`,
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason === "end_turn") {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text).join("\n");
      const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
      context.log("info", `claude-execute (SDK) done. Cost: $${cost.toFixed(4)}`);
      return { text, sessionId: null, cost };
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          type: "tool_result" as const,
          tool_use_id: b.id,
          content: runTool(b.name, b.input as Record<string, string>, cwd),
        }));
      messages.push({ role: "user", content: results });
      continue;
    }

    break; // max_tokens or unexpected stop
  }

  const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
  return { text: "(max turns reached)", sessionId: null, cost };
}

// ── Skill ──────────────────────────────────────────────────────────────────

export class ClaudeExecuteSkill extends BaseSkill<Input, Output> {
  readonly id = "claude-execute";
  readonly name = "Claude Execute";
  readonly description =
    "Execute code analysis or generation tasks using Claude AI";
  readonly tags = ["ai", "code", "analysis", "modification", "review"];
  readonly inputSchema = inputSchema;

  async execute(input: Input, context: SkillContext): Promise<Output> {
    context.log("info", `claude-execute: "${input.prompt.slice(0, 80)}..."`);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey?.startsWith("sk-ant-api03-")) {
      context.log("info", "Using Anthropic SDK (ANTHROPIC_API_KEY found)");
      return callSdk(input, context);
    }

    context.log("info", "Using persistent ClaudeProcess (CLAUDE_CODE_SIMPLE=1, --strict-mcp-config)");
    return sendToClaudeProcess(input, context);
  }
}