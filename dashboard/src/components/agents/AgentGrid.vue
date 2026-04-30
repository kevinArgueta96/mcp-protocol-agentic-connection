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
        <section v-if="projectGroups.length > 0">
          <div class="section-label-row">
            <span class="section-label section-label--accent">Client Sessions</span>
            <span class="section-count">{{ clientList.length }} clients · {{ projectGroups.length }} projects</span>
          </div>
          <TransitionGroup tag="div" name="agent-fade" class="conversation-stack">
            <ProjectClientGroup
              v-for="group in projectGroups"
              :key="group.projectPath"
              :project-name="group.projectName"
              :project-path="group.projectPath"
              :clients="group.clients"
            />
          </TransitionGroup>
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

const projectGroups = computed<ProjectGroup[]>(() => {
  const map = new Map<string, ProjectGroup>();
  for (const client of clientList.value) {
    const key = client.projectPath || client.agentId;
    if (!map.has(key)) {
      map.set(key, {
        projectPath: client.projectPath,
        projectName: client.projectName || key,
        clients: [],
      });
    }
    map.get(key)!.clients.push(client);
  }
  return Array.from(map.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
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
</style>
