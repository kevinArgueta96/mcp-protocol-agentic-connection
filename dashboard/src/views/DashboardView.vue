<template>
  <div class="app-shell">
    <AppHeader />
    <div class="app-frame dashboard-grid">
      <div class="app-column">
        <AgentGrid />
      </div>
      <div class="app-column">
        <TraceTimeline />
      </div>
      <div class="app-column">
        <ClientMessagePanel />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppHeader from "@/components/layout/AppHeader.vue";
import AgentGrid from "@/components/agents/AgentGrid.vue";
import TraceTimeline from "@/components/trace/TraceTimeline.vue";
import ClientMessagePanel from "@/components/chat/ClientMessagePanel.vue";
</script>
