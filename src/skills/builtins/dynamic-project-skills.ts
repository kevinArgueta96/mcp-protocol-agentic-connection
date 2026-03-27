// Built-in: dynamically detected project skills
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BaseSkill } from "../framework.js";
import { ClaudeExecuteSkill } from "./claude-execute.js";
import { ShellExecuteSkill } from "./shell-execute.js";
import type { SkillContext } from "../../types/skills.js";

// ── Shell-delegate base: uses ShellExecuteSkill directly (no Claude Code login needed) ──

abstract class ShellDelegateSkill extends BaseSkill<{ query: string }, unknown> {
  readonly inputSchema = z.object({
    query: z.string().describe("Command or script name to run"),
  });

  private readonly shell = new ShellExecuteSkill();

  protected abstract resolveCommand(query: string, projectPath: string): string;

  async execute(input: { query: string }, context: SkillContext) {
    const command = this.resolveCommand(input.query, context.projectPath);
    const result = await this.shell.execute({ command, timeout: 60_000 }, context);
    const lines: string[] = [];
    if (result.stdout) lines.push(result.stdout.trimEnd());
    if (result.stderr) lines.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.timedOut) lines.push("[timed out]");
    return {
      text: lines.join("\n") || "(no output)",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };
  }
}

// ── AI-delegate base: uses ClaudeExecuteSkill (requires API key or Claude CLI) ──

abstract class DelegateSkill extends BaseSkill<{ query: string }, unknown> {
  readonly inputSchema = z.object({
    query: z.string().describe("What to do or ask"),
  });

  protected abstract readonly promptPrefix: string;
  protected abstract readonly allowedTools: string[];

  private readonly delegate = new ClaudeExecuteSkill();

  async execute(input: { query: string }, context: SkillContext) {
    return this.delegate.execute(
      { prompt: `${this.promptPrefix}\n\n${input.query}`, allowedTools: this.allowedTools },
      context
    );
  }
}

// ── Detect available package manager ──────────────────────────────────────────

function detectPkgManager(projectPath: string): string {
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectPath, "yarn.lock"))) return "yarn";
  return "npm";
}

// ── Detect test runner ────────────────────────────────────────────────────────

function detectTestCommand(projectPath: string): string {
  const pkgManager = detectPkgManager(projectPath);

  // Check package.json scripts first
  try {
    const pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (pkg.scripts?.test) return `${pkgManager} test`;
  } catch { /* ignore */ }

  // Vitest
  if (
    existsSync(join(projectPath, "vitest.config.ts")) ||
    existsSync(join(projectPath, "vitest.config.js"))
  ) return "npx vitest run";

  // Jest
  if (
    existsSync(join(projectPath, "jest.config.ts")) ||
    existsSync(join(projectPath, "jest.config.js"))
  ) return "npx jest";

  // Python
  if (existsSync(join(projectPath, "pytest.ini")) || existsSync(join(projectPath, "pyproject.toml"))) {
    return "python -m pytest";
  }

  // Maven
  if (existsSync(join(projectPath, "pom.xml"))) return "mvn test";

  return `${pkgManager} test`;
}

// ── Concrete skills ───────────────────────────────────────────────────────────

export class RunScriptSkill extends ShellDelegateSkill {
  readonly id = "run-script";
  readonly name = "Run Script";
  readonly description = "Run a package.json script or shell command in the project directory. Returns stdout and stderr.";
  readonly tags = ["npm", "script", "build", "shell"];

  protected resolveCommand(query: string, projectPath: string): string {
    const pm = detectPkgManager(projectPath);
    const q = query.trim();

    // If query looks like a bare script name (no spaces, no special chars) → npm run <script>
    if (/^[a-z0-9:_-]+$/i.test(q)) {
      // Check if it's an actual package.json script
      try {
        const pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        };
        if (pkg.scripts?.[q]) return `${pm} run ${q}`;
      } catch { /* ignore */ }
    }

    // Otherwise treat the whole query as a shell command
    return q;
  }
}

export class RunTestsSkill extends ShellDelegateSkill {
  readonly id = "run-tests";
  readonly name = "Run Tests";
  readonly description = "Run the project test suite and return results (stdout + stderr).";
  readonly tags = ["test", "ci", "quality"];

  protected resolveCommand(_query: string, projectPath: string): string {
    return detectTestCommand(projectPath);
  }
}

export class DockerBuildSkill extends ShellDelegateSkill {
  readonly id = "docker-build";
  readonly name = "Docker Build";
  readonly description = "Build the Docker image for this project using the Dockerfile.";
  readonly tags = ["docker", "build", "deploy"];

  protected resolveCommand(_query: string, _projectPath: string): string {
    return "docker build .";
  }
}

export class CodeReviewSkill extends DelegateSkill {
  readonly id = "code-review";
  readonly name = "Code Review";
  readonly description = "Review code for quality issues, bugs, and improvements (uses Claude AI)";
  readonly tags = ["review", "quality", "analysis"];
  protected readonly promptPrefix =
    "Review the code in this project. Look for bugs, quality issues, and suggest improvements. Focus on correctness and maintainability.";
  protected readonly allowedTools = ["Read", "Glob", "Grep"];
}

// ── Factory: detect which skills are relevant for a project ──────────────────

export function detectDynamicSkills(projectPath: string): BaseSkill[] {
  const skills: BaseSkill[] = [];

  const hasTests = ["jest.config", "vitest.config", "pytest.ini", "pyproject.toml", "pom.xml"].some(
    (f) =>
      existsSync(join(projectPath, f)) ||
      existsSync(join(projectPath, f + ".ts")) ||
      existsSync(join(projectPath, f + ".js"))
  );
  if (hasTests) skills.push(new RunTestsSkill());

  if (existsSync(join(projectPath, "Dockerfile"))) skills.push(new DockerBuildSkill());

  if (existsSync(join(projectPath, "package.json"))) skills.push(new RunScriptSkill());

  if (existsSync(join(projectPath, "src"))) skills.push(new CodeReviewSkill());

  return skills;
}
