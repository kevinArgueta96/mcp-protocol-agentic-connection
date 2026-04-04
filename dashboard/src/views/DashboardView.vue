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
        <AgentChat />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppHeader from "@/components/layout/AppHeader.vue";
import AgentGrid from "@/components/agents/AgentGrid.vue";
import TraceTimeline from "@/components/trace/TraceTimeline.vue";
import AgentChat from "@/components/chat/AgentChat.vue";
</script>
