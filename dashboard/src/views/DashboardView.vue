<template>
  <div style="height:100vh;display:flex;flex-direction:column;background:var(--bg);overflow:hidden;">
    <AppHeader />
    <div style="flex:1;display:grid;grid-template-columns:260px 1fr 300px;min-height:0;overflow:hidden;">
      <div style="border-right:1px solid var(--border-dim);overflow:hidden;display:flex;flex-direction:column;">
        <AgentGrid />
      </div>
      <div style="border-right:1px solid var(--border-dim);overflow:hidden;display:flex;flex-direction:column;">
        <TraceTimeline />
      </div>
      <div style="overflow:hidden;display:flex;flex-direction:column;">
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
