import type { ZodSchema } from "zod";
import type { AgentSkill } from "../types/a2a.js";
import type { SkillContext, SkillDefinition } from "../types/skills.js";
export declare abstract class BaseSkill<TInput = unknown, TOutput = unknown> {
    abstract readonly id: string;
    abstract readonly name: string;
    abstract readonly description: string;
    abstract readonly tags: string[];
    abstract readonly inputSchema: ZodSchema;
    abstract execute(input: TInput, context: SkillContext): Promise<TOutput>;
    toDefinition(): SkillDefinition;
    toAgentSkill(): AgentSkill;
}
export declare class SkillRegistry {
    private skills;
    register(skill: BaseSkill): void;
    get(id: string): BaseSkill | undefined;
    list(): SkillDefinition[];
    findByTag(tag: string): BaseSkill[];
    toAgentSkills(): AgentSkill[];
    size(): number;
}
//# sourceMappingURL=framework.d.ts.map