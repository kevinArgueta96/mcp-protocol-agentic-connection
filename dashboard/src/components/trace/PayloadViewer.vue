<template>
  <div class="payload-viewer">
    <pre class="payload-pre">{{ formatted }}</pre>
    <button class="btn-ghost payload-copy" @click="copyToClipboard">
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
