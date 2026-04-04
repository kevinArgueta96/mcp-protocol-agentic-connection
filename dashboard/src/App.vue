<template>
  <RouterView />
</template>

<script setup lang="ts">
import { RouterView } from "vue-router";
import { onUnmounted } from "vue";
import { useRegistryStore } from "@/stores/registry";
import { useTraceStore } from "@/stores/trace";
import { useChatStore } from "@/stores/chat";

const registryStore = useRegistryStore();
const traceStore = useTraceStore();
const chatStore = useChatStore();

onUnmounted(() => {
  registryStore.disconnect();
  traceStore.destroy();
  chatStore.destroy();
});
</script>
