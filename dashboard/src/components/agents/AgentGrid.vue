<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- Panel header -->
    <div class="flex items-center justify-between px-3 py-2 border-b border-white/5 shrink-0">
      <span class="font-mono text-[10px] text-white/40 uppercase tracking-wider">Agents</span>
      <span class="font-mono text-[10px] text-white/30">{{ agentList.length }} registered</span>
    </div>

    <!-- Empty state -->
    <div
      v-if="agentList.length === 0"
      class="flex flex-col items-center justify-center h-full text-center px-6"
    >
      <div class="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center mb-3">
        <span class="text-white/20 font-mono text-sm">?</span>
      </div>
      <p class="text-white/30 text-xs font-mono">No agents connected</p>
      <p class="text-white/20 text-[10px] mt-1 font-mono">
        Run <span class="text-white/40">agent-bridge start .</span>
      </p>
    </div>

    <div v-else class="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
      <!-- AI Clients section -->
      <div v-if="clientList.length > 0">
        <div class="flex items-center gap-1.5 mb-2">
          <span class="font-mono text-[9px] text-violet-400/70 uppercase tracking-wider">Clients</span>
          <span class="font-mono text-[9px] text-white/20">{{ clientList.length }}</span>
        </div>
        <div class="flex flex-col gap-2">
          <AgentCard
            v-for="agent in clientList"
            :key="agent.agentId"
            :agent="agent"
          />
        </div>
      </div>

      <!-- Skill Agents section -->
      <div v-if="skillAgentList.length > 0">
        <div class="flex items-center gap-1.5 mb-2" :class="clientList.length > 0 ? 'mt-1' : ''">
          <span class="font-mono text-[9px] text-white/40 uppercase tracking-wider">Skill Agents</span>
          <span class="font-mono text-[9px] text-white/20">{{ skillAgentList.length }}</span>
        </div>
        <div class="flex flex-col gap-2">
          <AgentCard
            v-for="agent in skillAgentList"
            :key="agent.agentId"
            :agent="agent"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRegistryStore } from "@/stores/registry";
import AgentCard from "./AgentCard.vue";

const store = useRegistryStore();
const agentList = computed(() => store.agentList);
const clientList = computed(() => agentList.value.filter((a) => a.entryType === "client"));
const skillAgentList = computed(() => agentList.value.filter((a) => a.entryType !== "client"));
</script>
