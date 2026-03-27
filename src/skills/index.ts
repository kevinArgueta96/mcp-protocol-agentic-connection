export { BaseSkill, SkillRegistry } from "./framework.js";
export { StateGraph, CompiledGraph } from "./state-graph.js";
export { FileSearchSkill } from "./builtins/file-search.js";
export { EndpointFindSkill } from "./builtins/endpoint-find.js";
export { CodeQuerySkill } from "./builtins/code-query.js";
export { PromptExecuteSkill } from "./builtins/prompt-execute.js";
export { ClaudeExecuteSkill } from "./builtins/claude-execute.js";
export { NotifyClaudeSkill } from "./builtins/notify-claude.js";
export { ShellExecuteSkill } from "./builtins/shell-execute.js";
export { RunTestsSkill, CodeReviewSkill, RunScriptSkill, DockerBuildSkill, detectDynamicSkills } from "./builtins/dynamic-project-skills.js";

import { SkillRegistry } from "./framework.js";
import { FileSearchSkill } from "./builtins/file-search.js";
import { EndpointFindSkill } from "./builtins/endpoint-find.js";
import { CodeQuerySkill } from "./builtins/code-query.js";
import { PromptExecuteSkill } from "./builtins/prompt-execute.js";
import { ClaudeExecuteSkill } from "./builtins/claude-execute.js";
import { NotifyClaudeSkill } from "./builtins/notify-claude.js";
import { ShellExecuteSkill } from "./builtins/shell-execute.js";
import { detectDynamicSkills } from "./builtins/dynamic-project-skills.js";

export function createDefaultRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(new FileSearchSkill());
  registry.register(new EndpointFindSkill());
  registry.register(new CodeQuerySkill());
  registry.register(new PromptExecuteSkill());
  registry.register(new NotifyClaudeSkill());
  registry.register(new ShellExecuteSkill());
  return registry;
}

export function createClaudeRegistry(projectPath: string): SkillRegistry {
  const registry = createDefaultRegistry();
  registry.register(new ClaudeExecuteSkill());
  for (const skill of detectDynamicSkills(projectPath)) {
    registry.register(skill);
  }
  return registry;
}
