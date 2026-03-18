<template>
  <div style="position:relative;display:flex;align-items:center;">
    <select
      class="sig-select"
      style="width:100%;padding:5px 24px 5px 9px;height:30px;font-size:11px;color:var(--text);"
      :value="selectedId"
      @change="onSelect"
    >
      <option value="">— select an agent —</option>
      <option
        v-for="agent in agentList"
        :key="agent.agentId"
        :value="agent.agentId"
        :disabled="!agent.healthy"
      >
        {{ agent.projectName }} (:{{ agent.port }}){{ agent.healthy ? "" : " [offline]" }}
      </option>
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

const agentList = computed(() => registryStore.agentList.filter((a) => a.entryType !== "client"));
const selectedId = computed(() => chatStore.selectedAgent?.agentId ?? "");

function onSelect(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  const agent = id ? registryStore.getAgent(id) : null;
  chatStore.selectAgent(agent ?? null);
}
</script>
