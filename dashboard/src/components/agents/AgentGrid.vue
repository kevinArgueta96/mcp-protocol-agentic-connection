<template>
  <div class="panel">
    <div class="panel-header">
      <div class="panel-heading">
        <span class="panel-label">Agents</span>
        <span class="panel-sublabel">registry snapshot — projects and connected agents</span>
      </div>
      <span class="panel-count">{{ clientList.length + skillAgentList.length }}</span>
    </div>

    <div class="section-frame panel-divider">
      <div v-if="agentList.length === 0" class="empty-state">
        <div class="empty-state__icon">
          <span>⬡</span>
        </div>
        <div>
          <p class="empty-state__title">No agents connected</p>
          <p class="empty-state__body">Start a local runtime with <code>open-agent-bridge start .</code> and the registry will begin streaming activity here.</p>
        </div>
      </div>

      <div v-else class="scrollable section-stack">
        <section v-if="clientList.length > 0">
          <div class="section-label-row">
            <span class="section-label section-label--accent">Client Sessions</span>
            <span class="section-count">{{ clientList.length }} clients · {{ identityGroups.length }} namespaces</span>
          </div>
          <div v-for="ig in identityGroups" :key="ig.identity" class="identity-group">
            <div class="identity-header">
              <span class="chip chip-identity">⛬ {{ ig.identity }}</span>
              <span class="section-count">{{ ig.clientCount }} clients · {{ ig.projects.length }} projects</span>
            </div>
            <TransitionGroup tag="div" name="agent-fade" class="conversation-stack">
              <ProjectClientGroup
                v-for="group in ig.projects"
                :key="group.projectPath"
                :project-name="group.projectName"
                :project-path="group.projectPath"
                :clients="group.clients"
              />
            </TransitionGroup>
          </div>
        </section>

        <section v-if="skillAgentList.length > 0">
          <div class="section-label-row">
            <span class="section-label">Runnable Agents</span>
            <span class="section-count">{{ skillAgentList.length }}</span>
          </div>
          <TransitionGroup tag="div" name="agent-fade" class="conversation-stack">
            <AgentCard v-for="a in skillAgentList" :key="a.agentId" :agent="a" />
          </TransitionGroup>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, TransitionGroup } from "vue";
import { useRegistryStore } from "@/stores/registry";
import AgentCard from "./AgentCard.vue";
import ProjectClientGroup from "./ProjectClientGroup.vue";
import type { RegistryAgent } from "@/types";

const store = useRegistryStore();
const agentList = computed(() => store.agentList);
// Filter out only the dashboard itself. Bridge sessions are deliverable clients
// and should remain visible in the registry view.
const clientList = computed(() =>
  agentList.value.filter(
    (a) =>
      a.entryType === "client" &&
      a.agentId !== store.dashboardClientId,
  ),
);
const skillAgentList = computed(() => agentList.value.filter((a) => a.entryType !== "client"));

interface ProjectGroup {
  projectPath: string;
  projectName: string;
  clients: RegistryAgent[];
}

interface IdentityGroup {
  identity: string;
  projects: ProjectGroup[];
  clientCount: number;
}

// Group client sessions first by channel namespace (identity), then by project
// within each namespace. The "global" namespace sorts first; the rest alphabetical.
const identityGroups = computed<IdentityGroup[]>(() => {
  const byIdentity = new Map<string, Map<string, ProjectGroup>>();
  for (const client of clientList.value) {
    const identity = client.identity || "global";
    const projKey = client.projectPath || client.agentId;
    if (!byIdentity.has(identity)) byIdentity.set(identity, new Map());
    const projects = byIdentity.get(identity)!;
    if (!projects.has(projKey)) {
      projects.set(projKey, {
        projectPath: client.projectPath,
        projectName: client.projectName || projKey,
        clients: [],
      });
    }
    projects.get(projKey)!.clients.push(client);
  }
  return Array.from(byIdentity.entries())
    .map(([identity, projects]) => {
      const list = Array.from(projects.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
      return {
        identity,
        projects: list,
        clientCount: list.reduce((n, p) => n + p.clients.length, 0),
      };
    })
    .sort((a, b) =>
      a.identity === "global" ? -1 : b.identity === "global" ? 1 : a.identity.localeCompare(b.identity),
    );
});
</script>

<style scoped>
.agent-fade-enter-active,
.agent-fade-leave-active {
  transition: all 0.3s ease;
}
.agent-fade-enter-from,
.agent-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
.agent-fade-leave-active {
  position: absolute;
  width: 100%;
}
.identity-group {
  margin-bottom: 14px;
}
.identity-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 8px;
}
.chip-identity {
  background: rgba(120, 200, 255, 0.14);
  color: #8fd0ff;
  border: 1px solid rgba(120, 200, 255, 0.3);
}
</style>
