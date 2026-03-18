const UNHEALTHY_THRESHOLD_MS = 90_000; // 90 seconds
const REMOVE_THRESHOLD_MS = 300_000; // 5 minutes
export class AgentStore {
    agents = new Map();
    register(registration) {
        const entry = {
            ...registration,
            lastHeartbeat: Date.now(),
            healthy: true,
        };
        this.agents.set(registration.agentId, entry);
        return entry;
    }
    deregister(agentId) {
        return this.agents.delete(agentId);
    }
    heartbeat(agentId) {
        const entry = this.agents.get(agentId);
        if (!entry)
            return false;
        this.agents.set(agentId, { ...entry, lastHeartbeat: Date.now(), healthy: true });
        return true;
    }
    get(agentId) {
        return this.agents.get(agentId);
    }
    list(filter) {
        let entries = Array.from(this.agents.values());
        if (filter?.healthy !== undefined) {
            entries = entries.filter((e) => e.healthy === filter.healthy);
        }
        if (filter?.skill) {
            const tag = filter.skill;
            entries = entries.filter((e) => e.card.skills.some((s) => s.tags.includes(tag) || s.id === tag));
        }
        if (filter?.project) {
            const project = filter.project.toLowerCase();
            entries = entries.filter((e) => e.projectPath.toLowerCase().includes(project) ||
                e.projectName.toLowerCase().includes(project));
        }
        return entries;
    }
    findBySkill(tag) {
        return this.list({ skill: tag });
    }
    findByProject(projectPath) {
        return this.agents.get([...this.agents.values()].find((e) => e.projectPath === projectPath)?.agentId ?? "");
    }
    healthCheck() {
        const now = Date.now();
        for (const [id, entry] of this.agents) {
            const age = now - entry.lastHeartbeat;
            if (age > REMOVE_THRESHOLD_MS) {
                this.agents.delete(id);
            }
            else if (age > UNHEALTHY_THRESHOLD_MS) {
                this.agents.set(id, { ...entry, healthy: false });
            }
        }
    }
    count() {
        return this.agents.size;
    }
}
//# sourceMappingURL=store.js.map