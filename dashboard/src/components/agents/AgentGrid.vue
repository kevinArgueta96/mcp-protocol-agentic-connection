<template>
  <div class="panel" style="--panel-color: var(--indigo);">

    <div class="panel-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="panel-label">Agents</span>
        <span class="panel-sublabel">registry</span>
      </div>
      <span style="font-size:10px;color:var(--text-dim);">{{ agentList.length }}</span>
    </div>

    <!-- Empty -->
    <div v-if="agentList.length === 0" style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;padding:24px;text-align:center;">
      <div style="width:32px;height:32px;border-radius:50%;border:1px solid var(--border-mid);display:flex;align-items:center;justify-content:center;">
        <span style="font-size:14px;color:var(--text-ghost);">⬡</span>
      </div>
      <div>
        <p style="font-size:11px;color:var(--text-mid);font-weight:600;margin:0 0 4px;">No agents connected</p>
        <p style="font-size:10px;color:var(--text-ghost);margin:0;">Run <span style="color:var(--text-dim);">agent-bridge start .</span></p>
      </div>
    </div>

    <div v-else class="scrollable" style="padding:10px;display:flex;flex-direction:column;gap:10px;">
      <!-- AI Clients -->
      <section v-if="clientList.length > 0">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:0 2px;margin-bottom:6px;">
          <span style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--indigo);">● clients</span>
          <span style="font-size:9px;color:var(--text-ghost);">{{ clientList.length }}</span>
        </div>
        <TransitionGroup tag="div" name="agent-fade" style="display:flex;flex-direction:column;gap:6px;">
          <AgentCard v-for="a in clientList" :key="a.agentId" :agent="a" />
        </TransitionGroup>
      </section>

      <!-- Skill Agents -->
      <section v-if="skillAgentList.length > 0">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:0 2px;margin-bottom:6px;">
          <span style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-mid);">◈ skill agents</span>
          <span style="font-size:9px;color:var(--text-ghost);">{{ skillAgentList.length }}</span>
        </div>
        <TransitionGroup tag="div" name="agent-fade" style="display:flex;flex-direction:column;gap:6px;">
          <AgentCard v-for="a in skillAgentList" :key="a.agentId" :agent="a" />
        </TransitionGroup>
      </section>
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
