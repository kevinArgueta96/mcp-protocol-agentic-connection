export { BaseSkill, SkillRegistry } from "./framework.js";
export { StateGraph, CompiledGraph } from "./state-graph.js";
export { FileSearchSkill } from "./builtins/file-search.js";
export { EndpointFindSkill } from "./builtins/endpoint-find.js";
export { CodeQuerySkill } from "./builtins/code-query.js";
export { PromptExecuteSkill } from "./builtins/prompt-execute.js";

import { SkillRegistry } from "./framework.js";
import { FileSearchSkill } from "./builtins/file-search.js";
import { EndpointFindSkill } from "./builtins/endpoint-find.js";
import { CodeQuerySkill } from "./builtins/code-query.js";
import { PromptExecuteSkill } from "./builtins/prompt-execute.js";

export function createDefaultRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(new FileSearchSkill());
  registry.register(new EndpointFindSkill());
  registry.register(new CodeQuerySkill());
  registry.register(new PromptExecuteSkill());
  return registry;
}
