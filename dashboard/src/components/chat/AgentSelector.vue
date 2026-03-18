<template>
  <div class="relative">
    <select
      class="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs font-mono text-white/70 focus:outline-none focus:border-white/25 appearance-none"
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
        {{ agent.projectName }} (:{{ agent.port }}) {{ agent.healthy ? "" : "[offline]" }}
      </option>
    </select>
    <span class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-white/30 text-[10px]">▾</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRegistryStore } from "@/stores/registry";
import { useChatStore } from "@/stores/chat";

const registryStore = useRegistryStore();
const chatStore = useChatStore();

const agentList = computed(() => registryStore.agentList);
const selectedId = computed(() => chatStore.selectedAgent?.agentId ?? "");

function onSelect(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  const agent = id ? registryStore.getAgent(id) : null;
  chatStore.selectAgent(agent ?? null);
}
</script>
