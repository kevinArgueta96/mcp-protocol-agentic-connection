<template>
  <div class="panel">
    <div class="panel-header">
      <div class="panel-heading">
        <span class="panel-label">Agents</span>
        <span class="panel-sublabel">registry snapshot split between runnable agents and connected passive client sessions</span>
      </div>
      <span class="panel-count">{{ agentList.length }}</span>
    </div>

    <div class="section-frame panel-divider">
      <div v-if="agentList.length === 0" class="empty-state">
        <div class="empty-state__icon">
          <span>⬡</span>
        </div>
        <div>
          <p class="empty-state__title">No agents connected</p>
          <p class="empty-state__body">Start a local runtime with <code>agent-bridge start .</code> and the registry will begin streaming activity here.</p>
        </div>
      </div>

      <div v-else class="scrollable section-stack">
        <section v-if="clientList.length > 0">
          <div class="section-label-row">
            <span class="section-label section-label--accent">Client Sessions</span>
            <span class="section-count">{{ clientList.length }}</span>
          </div>
          <TransitionGroup tag="div" name="agent-fade" class="conversation-stack">
            <AgentCard v-for="a in clientList" :key="a.agentId" :agent="a" />
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

const store = useRegistryStore();
const agentList = computed(() => store.agentList);
const clientList = computed(() => agentList.value.filter((a) => a.entryType === "client"));
const skillAgentList = computed(() => agentList.value.filter((a) => a.entryType !== "client"));
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
