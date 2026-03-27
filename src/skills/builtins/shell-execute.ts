// Built-in skill: execute shell commands directly in the agent's project directory
import { z } from "zod";
import { exec } from "node:child_process";
import { resolve, relative } from "node:path";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";

const MAX_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 1024 * 1024; // 1 MB

const inputSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  timeout: z
    .number()
    .optional()
    .describe("Timeout in milliseconds (default: 30000, max: 120000)"),
  cwd: z
    .string()
    .optional()
    .describe("Working directory relative to the project root (defaults to project root)"),
});

const outputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  timedOut: z.boolean(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

export class ShellExecuteSkill extends BaseSkill<Input, Output> {
  readonly id = "shell-execute";
  readonly name = "Shell Execute";
  readonly description =
    "Execute a shell command directly in the project directory. " +
    "Returns stdout, stderr, and exit code. No Claude Code login required.";
  readonly tags = ["shell", "exec", "command", "run"];
  readonly inputSchema = inputSchema;

  async execute(input: Input, context: SkillContext): Promise<Output> {
    const timeoutMs = Math.min(input.timeout ?? 30_000, MAX_TIMEOUT_MS);

    // Resolve cwd safely — must stay inside projectPath
    let cwd = context.projectPath;
    if (input.cwd) {
      const resolved = resolve(context.projectPath, input.cwd);
      // Guard: prevent escaping the project root
      const rel = relative(context.projectPath, resolved);
      if (rel.startsWith("..")) {
        return {
          stdout: "",
          stderr: `Error: cwd "${input.cwd}" would escape the project root`,
          exitCode: 1,
          timedOut: false,
        };
      }
      cwd = resolved;
    }

    context.log("info", `[shell-execute] $ ${input.command} (cwd: ${cwd}, timeout: ${timeoutMs}ms)`);

    return new Promise<Output>((resolve) => {
      let timedOut = false;

      const child = exec(
        input.command,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER_BYTES,
          shell: "/bin/sh",
        },
        (error, stdout, stderr) => {
          if (error?.killed || timedOut) {
            timedOut = true;
            resolve({
              stdout: stdout ?? "",
              stderr: `Command timed out after ${timeoutMs}ms`,
              exitCode: 124,
              timedOut: true,
            });
            return;
          }

          const exitCode = error?.code ?? (error ? 1 : 0);
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: typeof exitCode === "number" ? exitCode : 1,
            timedOut: false,
          });
        }
      );

      // Handle timeout separately to set the flag before callback fires
      setTimeout(() => { timedOut = true; }, timeoutMs);

      child.on("error", (err) => {
        resolve({
          stdout: "",
          stderr: `Failed to spawn process: ${err.message}`,
          exitCode: 1,
          timedOut: false,
        });
      });
    });
  }
}
