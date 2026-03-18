<template>
  <span class="health-dot" title="Connected" />
</template>

<script setup lang="ts">
</script>

<style scoped>
.health-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--emerald);
  box-shadow: 0 0 4px var(--emerald);
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 4px var(--emerald); }
  50% { opacity: 0.7; box-shadow: 0 0 8px var(--emerald); }
}
</style>
