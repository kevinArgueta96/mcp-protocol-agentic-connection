<template>
  <div class="toolbar-field agent-selector-field">
    <label class="toolbar-label">Send Tasks To</label>
    <div class="select-wrap">
      <select class="sig-select" :value="selectedId" @change="onSelect">
        <option value="">Choose a runnable agent</option>
        <optgroup v-if="skillAgents.length > 0" label="Runnable agents">
          <option
            v-for="agent in skillAgents"
            :key="agent.agentId"
            :value="agent.agentId"
          >
            {{ agent.projectName }} (:{{ agent.port }})
          </option>
        </optgroup>
        <optgroup v-if="clientAgents.length > 0" label="Claude clients (channel-only)">
          <option
            v-for="agent in clientAgents"
            :key="agent.agentId"
            disabled
          >
            {{ agent.clientInfo?.clientName ?? agent.name }} — connected
          </option>
        </optgroup>
      </select>
      <span class="select-caret">▾</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRegistryStore } from "@/stores/registry";
import { useChatStore } from "@/stores/chat";

const registryStore = useRegistryStore();
const chatStore = useChatStore();

const healthyAgents = computed(() => registryStore.agentList.filter((a) => a.healthy));
const skillAgents = computed(() => healthyAgents.value.filter((a) => a.entryType !== "client"));
const clientAgents = computed(() => healthyAgents.value.filter((a) => a.entryType === "client"));
const selectedId = computed(() => chatStore.selectedAgent?.agentId ?? "");

function onSelect(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  const agent = id ? registryStore.getAgent(id) : null;
  chatStore.selectAgent(agent ?? null);
}
</script>

<style scoped>
.agent-selector-field {
  min-width: 100%;
}
</style>
