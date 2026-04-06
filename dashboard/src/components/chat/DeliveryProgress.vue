<template>
  <div class="delivery-progress">
    <div
      v-for="(step, i) in steps"
      :key="step.key"
      class="dp-step"
    >
      <div
        class="dp-node"
        :class="{
          'dp-node--active': isActive(i),
          'dp-node--done': isDone(i),
          'dp-node--failed': props.state === 'failed' && i === currentIndex
        }"
        :title="step.label"
      />
      <div v-if="i < steps.length - 1" class="dp-line" :class="{ 'dp-line--done': isDone(i) }" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

type DeliveryState = 'queued' | 'delivered_to_bridge' | 'displayed_to_client' | 'answered' | 'failed'

const props = defineProps<{ state: DeliveryState }>()

const steps = [
  { key: 'queued', label: 'Queued' },
  { key: 'delivered_to_bridge', label: 'Delivered to bridge' },
  { key: 'displayed_to_client', label: 'Shown to client' },
  { key: 'answered', label: 'Answered' },
]

const ORDER: DeliveryState[] = ['queued', 'delivered_to_bridge', 'displayed_to_client', 'answered']

const currentIndex = computed(() => {
  if (props.state === 'failed') return ORDER.indexOf('queued')
  return ORDER.indexOf(props.state as any) ?? 0
})

function isDone(i: number) {
  return i < currentIndex.value
}
function isActive(i: number) {
  return i === currentIndex.value
}
</script>

<style scoped>
.delivery-progress {
  display: flex;
  align-items: center;
  gap: 0;
  margin-top: 6px;
  opacity: 0.85;
}
.dp-step {
  display: flex;
  align-items: center;
}
.dp-node {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(185, 159, 134, 0.3);
  border: 1.5px solid rgba(185, 159, 134, 0.4);
  transition: background 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;
  flex-shrink: 0;
}
.dp-node--done {
  background: var(--emerald);
  border-color: var(--emerald);
}
.dp-node--active {
  background: var(--amber);
  border-color: var(--amber);
  box-shadow: 0 0 6px rgba(255, 197, 108, 0.5);
  animation: dp-pulse 1.4s ease-in-out infinite;
}
.dp-node--failed {
  background: var(--red);
  border-color: var(--red);
}
.dp-line {
  width: 18px;
  height: 1.5px;
  background: rgba(185, 159, 134, 0.25);
  transition: background 0.3s ease;
}
.dp-line--done {
  background: var(--emerald);
}
@keyframes dp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
</style>
