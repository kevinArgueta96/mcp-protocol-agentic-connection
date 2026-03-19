<template>
  <div style="position:relative;display:flex;align-items:center;">
    <select
      class="sig-select"
      style="width:100%;padding:5px 24px 5px 9px;height:30px;font-size:11px;color:var(--text);"
      :value="selectedId"
      @change="onSelect"
    >
      <option value="">— select an agent —</option>
      <optgroup v-if="skillAgents.length > 0" label="Skill Agents">
        <option
          v-for="agent in skillAgents"
          :key="agent.agentId"
          :value="agent.agentId"
        >
          {{ agent.projectName }} (:{{ agent.port }})
        </option>
      </optgroup>
      <optgroup v-if="clientAgents.length > 0" label="AI Clients (read-only)">
        <option
          v-for="agent in clientAgents"
          :key="agent.agentId"
          disabled
        >
          {{ agent.clientInfo?.clientName ?? agent.name }} — connected
        </option>
      </optgroup>
    </select>
    <span style="position:absolute;right:7px;pointer-events:none;font-size:9px;color:var(--text-dim);">▾</span>
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
