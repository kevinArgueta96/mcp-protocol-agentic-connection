// In-memory agent store for the registry
import type { AgentRegistration, AgentListFilter, RegistryEntry } from "../types/messages.js";
import type { RegistryEventBus } from "./events.js";

const UNHEALTHY_THRESHOLD_MS = 90_000;   // 90 seconds
const REMOVE_THRESHOLD_MS = 300_000;      // 5 minutes

export class AgentStore {
  private agents = new Map<string, RegistryEntry>();

  constructor(private readonly eventBus?: RegistryEventBus) {}

  register(registration: AgentRegistration): RegistryEntry {
    // Replace stale entries for the same logical runtime.
    // This keeps the dashboard stable when Claude reconnects for the same project.
    for (const [existingId, existing] of this.agents.entries()) {
      const sameClientSession =
        registration.entryType === "client" &&
        existing.entryType === "client" &&
        existing.projectPath === registration.projectPath &&
        existing.clientInfo?.clientName === registration.clientInfo?.clientName;

      const sameProjectAgent =
        (registration.entryType ?? "agent") === "agent" &&
        (existing.entryType ?? "agent") === "agent" &&
        existing.projectPath === registration.projectPath;

      if ((sameClientSession || sameProjectAgent) && existingId !== registration.agentId) {
        this.agents.delete(existingId);
        this.eventBus?.broadcast({
          type: "agent.deregistered",
          timestamp: new Date().toISOString(),
          data: { agentId: existingId },
        });
      }
    }

    const entry: RegistryEntry = {
      ...registration,
      lastHeartbeat: Date.now(),
      healthy: true,
    };
    this.agents.set(registration.agentId, entry);
    this.eventBus?.broadcast({
      type: "agent.registered",
      timestamp: new Date().toISOString(),
      data: entry,
    });
    return entry;
  }

  deregister(agentId: string): boolean {
    const removed = this.agents.delete(agentId);
    if (removed) {
      this.eventBus?.broadcast({
        type: "agent.deregistered",
        timestamp: new Date().toISOString(),
        data: { agentId },
      });
    }
    return removed;
  }

  heartbeat(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    const timestamp = new Date().toISOString();
    this.agents.set(agentId, { ...entry, lastHeartbeat: Date.now(), healthy: true });
    this.eventBus?.broadcast({
      type: "agent.heartbeat",
      timestamp,
      data: { agentId, timestamp },
    });
    return true;
  }

  get(agentId: string): RegistryEntry | undefined {
    return this.agents.get(agentId);
  }

  list(filter?: AgentListFilter): RegistryEntry[] {
    let entries = Array.from(this.agents.values());

    if (filter?.healthy !== undefined) {
      entries = entries.filter((e) => e.healthy === filter.healthy);
    }
    if (filter?.skill) {
      const tag = filter.skill;
      entries = entries.filter((e) =>
        e.card.skills.some((s) => s.tags.includes(tag) || s.id === tag)
      );
    }
    if (filter?.project) {
      const project = filter.project.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.projectPath.toLowerCase().includes(project) ||
          e.projectName.toLowerCase().includes(project)
      );
    }
    if (filter?.entryType) {
      entries = entries.filter((e) => e.entryType === filter.entryType);
    }

    return entries;
  }

  findBySkill(tag: string): RegistryEntry[] {
    return this.list({ skill: tag });
  }

  findByProject(projectPath: string): RegistryEntry | undefined {
    return this.agents.get(
      [...this.agents.values()].find((e) => e.projectPath === projectPath)?.agentId ?? ""
    );
  }

  healthCheck(): void {
    const now = Date.now();
    for (const [id, entry] of this.agents) {
      const age = now - entry.lastHeartbeat;
      if (age > REMOVE_THRESHOLD_MS) {
        this.agents.delete(id);
        this.eventBus?.broadcast({
          type: "agent.removed",
          timestamp: new Date().toISOString(),
          data: { agentId: id },
        });
      } else if (age > UNHEALTHY_THRESHOLD_MS && entry.healthy) {
        this.agents.set(id, { ...entry, healthy: false });
        this.eventBus?.broadcast({
          type: "agent.unhealthy",
          timestamp: new Date().toISOString(),
          data: { agentId: id },
        });
      }
    }
  }

  count(): number {
    return this.agents.size;
  }
}
