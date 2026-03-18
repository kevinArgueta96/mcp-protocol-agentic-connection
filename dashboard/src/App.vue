<template>
  <RouterView />
</template>

<script setup lang="ts">
import { RouterView } from "vue-router";
import { onUnmounted } from "vue";
import { useRegistryStore } from "@/stores/registry";
import { useTraceStore } from "@/stores/trace";

const registryStore = useRegistryStore();
const traceStore = useTraceStore();

onUnmounted(() => {
  registryStore.disconnect();
  traceStore.destroy();
});
</script>