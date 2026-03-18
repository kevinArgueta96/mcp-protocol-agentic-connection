// Skill base class and registry
// TODO: implement BaseSkill and SkillRegistry

import type { ZodSchema } from "zod";
import type { AgentSkill } from "../types/a2a.js";
import type { SkillContext, SkillDefinition } from "../types/skills.js";

export abstract class BaseSkill<TInput = unknown, TOutput = unknown> {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly tags: string[];
  // Using ZodSchema (no generic) to allow ZodDefault/ZodOptional schemas without variance issues
  abstract readonly inputSchema: ZodSchema;

  abstract execute(input: TInput, context: SkillContext): Promise<TOutput>;

  toDefinition(): SkillDefinition {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      tags: this.tags,
      inputSchema: this.inputSchema,
    };
  }

  toAgentSkill(): AgentSkill {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      tags: this.tags,
    };
  }
}

export class SkillRegistry {
  private skills = new Map<string, BaseSkill>();

  register(skill: BaseSkill): void {
    this.skills.set(skill.id, skill);
  }

  get(id: string): BaseSkill | undefined {
    return this.skills.get(id);
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values()).map((s) => s.toDefinition());
  }

  findByTag(tag: string): BaseSkill[] {
    return Array.from(this.skills.values()).filter((s) => s.tags.includes(tag));
  }

  toAgentSkills(): AgentSkill[] {
    return Array.from(this.skills.values()).map((s) => s.toAgentSkill());
  }

  size(): number {
    return this.skills.size;
  }
}
