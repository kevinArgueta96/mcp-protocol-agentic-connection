// Built-in: dynamically detected project skills using Claude Code
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BaseSkill } from "../framework.js";
import { ClaudeExecuteSkill } from "./claude-execute.js";
import type { SkillContext } from "../../types/skills.js";

// Delegate skill: wraps ClaudeExecuteSkill with a fixed prompt prefix and tools
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

export class RunTestsSkill extends DelegateSkill {
  readonly id = "run-tests";
  readonly name = "Run Tests";
  readonly description = "Run the project test suite and report results";
  readonly tags = ["test", "ci", "quality"];
  protected readonly promptPrefix = "Run the tests in this project. Report which tests pass and which fail, with a summary.";
  protected readonly allowedTools = ["Read", "Bash", "Glob"];
}

export class CodeReviewSkill extends DelegateSkill {
  readonly id = "code-review";
  readonly name = "Code Review";
  readonly description = "Review code for quality issues, bugs, and improvements";
  readonly tags = ["review", "quality", "analysis"];
  protected readonly promptPrefix = "Review the code in this project. Look for bugs, quality issues, and suggest improvements. Focus on correctness and maintainability.";
  protected readonly allowedTools = ["Read", "Glob", "Grep"];
}

export class RunScriptSkill extends DelegateSkill {
  readonly id = "run-script";
  readonly name = "Run Script";
  readonly description = "Run a package.json script or command in the project";
  readonly tags = ["npm", "script", "build"];
  protected readonly promptPrefix = "Run the requested npm/pnpm script or command in this project. Read package.json first to find available scripts.";
  protected readonly allowedTools = ["Read", "Bash"];
}

export class DockerBuildSkill extends DelegateSkill {
  readonly id = "docker-build";
  readonly name = "Docker Build";
  readonly description = "Build and validate the Docker image for this project";
  readonly tags = ["docker", "build", "deploy"];
  protected readonly promptPrefix = "Build the Docker image for this project using the Dockerfile. Report the build result and any errors.";
  protected readonly allowedTools = ["Read", "Bash"];
}

// Factory: detect which skills are relevant for a project
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
