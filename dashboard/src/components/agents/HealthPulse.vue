<template>
  <span
    class="health-dot"
    :class="healthy ? 'pulse-healthy' : 'pulse-error'"
    :style="{ background: healthy ? 'var(--emerald)' : 'var(--red)' }"
    :title="healthy ? 'Healthy' : 'Unhealthy'"
  />
</template>

<script setup lang="ts">
defineProps<{ healthy: boolean }>();
</script>

<style scoped>
.health-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
