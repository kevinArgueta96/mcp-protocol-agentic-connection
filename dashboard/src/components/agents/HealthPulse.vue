<template>
  <span
    class="inline-block w-2 h-2 rounded-full shrink-0"
    :class="dotClass"
    :title="healthy ? 'Healthy' : 'Unhealthy'"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ healthy: boolean }>();

const dotClass = computed(() =>
  props.healthy
    ? "bg-emerald-400 pulse-healthy"
    : "bg-red-500 pulse-error"
);
</script>
