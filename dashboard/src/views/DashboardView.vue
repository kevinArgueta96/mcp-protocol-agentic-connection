<template>
  <div class="flex flex-col h-screen bg-[#0a0e14]">
    <AppHeader />

    <!-- 3-panel layout -->
    <div class="flex-1 grid grid-cols-[280px_1fr_320px] min-h-0 divide-x divide-white/5">
      <!-- Left: Agent grid -->
      <AgentGrid />

      <!-- Center: Trace timeline -->
      <TraceTimeline />

      <!-- Right: Chat -->
      <AgentChat />
    </div>
  </div>
</template>

<script setup lang="ts">
import AppHeader from "@/components/layout/AppHeader.vue";
import AgentGrid from "@/components/agents/AgentGrid.vue";
import TraceTimeline from "@/components/trace/TraceTimeline.vue";
import AgentChat from "@/components/chat/AgentChat.vue";
</script>
