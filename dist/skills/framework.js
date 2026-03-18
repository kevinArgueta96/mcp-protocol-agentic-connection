// Skill base class and registry
// TODO: implement BaseSkill and SkillRegistry
export class BaseSkill {
    toDefinition() {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            tags: this.tags,
            inputSchema: this.inputSchema,
        };
    }
    toAgentSkill() {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            tags: this.tags,
        };
    }
}
export class SkillRegistry {
    skills = new Map();
    register(skill) {
        this.skills.set(skill.id, skill);
    }
    get(id) {
        return this.skills.get(id);
    }
    list() {
        return Array.from(this.skills.values()).map((s) => s.toDefinition());
    }
    findByTag(tag) {
        return Array.from(this.skills.values()).filter((s) => s.tags.includes(tag));
    }
    toAgentSkills() {
        return Array.from(this.skills.values()).map((s) => s.toAgentSkill());
    }
    size() {
        return this.skills.size;
    }
}
//# sourceMappingURL=framework.js.map