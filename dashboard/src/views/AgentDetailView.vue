<template>
  <div class="flex flex-col h-screen bg-[#0a0e14]">
    <AppHeader />

    <div class="flex-1 overflow-y-auto p-6">
      <!-- Back link -->
      <RouterLink
        to="/"
        class="inline-flex items-center gap-1.5 text-xs font-mono text-white/40 hover:text-white/70 transition-colors mb-6"
      >
        ← back to dashboard
      </RouterLink>

      <!-- Not found -->
      <div v-if="!agent" class="text-center py-20">
        <p class="font-mono text-white/30 text-sm">Agent not found</p>
        <p class="font-mono text-white/20 text-xs mt-2">{{ agentId }}</p>
      </div>

      <template v-else>
        <!-- Header -->
        <div class="flex items-center gap-3 mb-6">
          <HealthPulse :healthy="agent.healthy" />
          <h1 class="text-lg font-semibold text-white">{{ agent.projectName }}</h1>
          <span
            class="px-1.5 py-0.5 rounded text-[10px] font-mono border border-white/15 text-white/50"
          >
            {{ agent.projectType }}
          </span>
          <span class="font-mono text-xs text-white/30 ml-auto">{{ agent.agentId }}</span>
        </div>

        <!-- Info grid -->
        <div class="grid grid-cols-2 gap-4 mb-6">
          <div class="card p-4">
            <p class="text-[10px] font-mono text-white/40 uppercase tracking-wider mb-2">Connection</p>
            <div class="space-y-1.5 font-mono text-xs">
              <div class="flex justify-between">
                <span class="text-white/40">HTTP</span>
                <span class="text-white/70">{{ agent.url }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-white/40">WebSocket</span>
                <span class="text-white/70">{{ agent.wsUrl }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-white/40">Port</span>
                <span class="text-white/70">{{ agent.port }}</span>
              </div>
            </div>
          </div>

          <div class="card p-4">
            <p class="text-[10px] font-mono text-white/40 uppercase tracking-wider mb-2">Project</p>
            <div class="space-y-1.5 font-mono text-xs">
              <div class="flex justify-between">
                <span class="text-white/40">Name</span>
                <span class="text-white/70">{{ agent.projectName }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-white/40">Type</span>
                <span class="text-white/70">{{ agent.projectType }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-white/40">Path</span>
                <span class="text-white/70 truncate max-w-[200px]" :title="agent.projectPath">
                  {{ agent.projectPath.split("/").slice(-2).join("/") }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Skills -->
        <div class="card p-4 mb-4">
          <p class="text-[10px] font-mono text-white/40 uppercase tracking-wider mb-3">
            Skills ({{ agent.card.skills.length }})
          </p>
          <div v-if="agent.card.skills.length === 0" class="text-white/30 text-xs font-mono">
            No skills registered
          </div>
          <div v-else class="grid gap-3">
            <div
              v-for="skill in agent.card.skills"
              :key="skill.id"
              class="border border-white/6 rounded p-3"
            >
              <div class="flex items-center gap-2 mb-1">
                <span class="font-mono text-xs font-semibold text-white/80">{{ skill.id }}</span>
                <span class="font-mono text-[10px] text-white/40">{{ skill.name }}</span>
              </div>
              <p class="text-[10px] text-white/40 mb-2">{{ skill.description }}</p>
              <div class="flex flex-wrap gap-1">
                <span
                  v-for="tag in skill.tags"
                  :key="tag"
                  class="px-1 py-0.5 rounded text-[9px] font-mono border border-white/10 text-white/30"
                >
                  {{ tag }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Full Agent Card JSON -->
        <div class="card p-4">
          <p class="text-[10px] font-mono text-white/40 uppercase tracking-wider mb-3">
            Agent Card (A2A)
          </p>
          <PayloadViewer :data="agent.card" />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useRegistryStore } from "@/stores/registry";
import AppHeader from "@/components/layout/AppHeader.vue";
import HealthPulse from "@/components/agents/HealthPulse.vue";
import PayloadViewer from "@/components/trace/PayloadViewer.vue";

const props = defineProps<{ id: string }>();

const store = useRegistryStore();
const agentId = computed(() => props.id);
const agent = computed(() => store.getAgent(props.id));
</script>
