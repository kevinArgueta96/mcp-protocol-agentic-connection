<template>
  <div class="font-mono text-[10px] leading-relaxed">
    <pre class="text-white/60 whitespace-pre-wrap break-all overflow-x-auto">{{ formatted }}</pre>
    <button
      class="mt-1 text-[9px] text-white/30 hover:text-white/60 transition-colors"
      @click="copyToClipboard"
    >
      {{ copied ? "copied!" : "copy" }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useClipboard } from "@vueuse/core";

const props = defineProps<{ data: unknown }>();

const formatted = computed(() => JSON.stringify(props.data, null, 2));

const { copy, copied } = useClipboard({ source: formatted });

function copyToClipboard() {
  copy(formatted.value);
}
</script>
