<template>
  <div class="app-shell">
    <AppHeader />
    <div class="app-frame">
      <div class="scrollable detail-page">
        <RouterLink to="/" class="back-link">
        ← back to dashboard
        </RouterLink>

        <template v-if="!agent">
          <div class="empty-state">
            <div class="empty-state__icon">?</div>
            <p class="empty-state__title">Agent not found</p>
            <p class="empty-state__body">{{ agentId }}</p>
          </div>
        </template>

        <template v-else>
          <div class="detail-hero">
            <HealthPulse :healthy="agent.healthy" />
            <h1 class="detail-title">{{ agent.projectName }}</h1>
            <span class="chip" :class="`type-${agent.projectType}`">{{ agent.projectType }}</span>
            <span class="message-card__token detail-agent-id">{{ agent.agentId }}</span>
          </div>

          <div class="detail-grid">
            <div class="detail-card">
              <p class="detail-card__title">Connection</p>
              <div class="detail-list">
                <div class="detail-row">
                  <span class="detail-key">HTTP</span>
                  <span class="detail-value">{{ agent.url }}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-key">WebSocket</span>
                  <span class="detail-value">{{ agent.wsUrl }}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-key">Port</span>
                  <span class="detail-value">{{ agent.port }}</span>
                </div>
              </div>
            </div>

            <div class="detail-card">
              <p class="detail-card__title">Project</p>
              <div class="detail-list">
                <div class="detail-row">
                  <span class="detail-key">Name</span>
                  <span class="detail-value">{{ agent.projectName }}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-key">Type</span>
                  <span class="detail-value">{{ agent.projectType }}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-key">Path</span>
                  <span class="detail-value" :title="agent.projectPath">
                    {{ agent.projectPath.split("/").slice(-2).join("/") }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div class="detail-card detail-section-gap">
            <p class="detail-card__title">Skills ({{ agent.card.skills.length }})</p>
            <div v-if="agent.card.skills.length === 0" class="empty-state detail-empty">
              <p class="empty-state__body">No skills registered.</p>
            </div>
            <div v-else class="conversation-stack">
              <div
                v-for="skill in agent.card.skills"
                :key="skill.id"
                class="message-card"
              >
                <div class="message-card__head">
                  <span class="message-card__sender">{{ skill.id }}</span>
                  <span class="message-card__token">{{ skill.name }}</span>
                </div>
                <div class="message-card__content">{{ skill.description }}</div>
                <div class="agent-card__skills">
                  <span
                    v-for="tag in skill.tags"
                    :key="tag"
                    class="chip chip-dim"
                  >
                    {{ tag }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div class="detail-card">
            <p class="detail-card__title">Agent Card (A2A)</p>
            <PayloadViewer :data="agent.card" />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useRegistryStore } from "@/stores/registry";
import AppHeader from "@/components/layout/AppHeader.vue";
import HealthPulse from "@/components/agents/HealthPulse.vue";
import PayloadViewer from "@/components/trace/PayloadViewer.vue";

const props = defineProps<{ id: string }>();

const store = useRegistryStore();
const agentId = computed(() => props.id);
const agent = computed(() => store.getAgent(props.id));
</script>

<style scoped>
.detail-agent-id {
  margin-left: auto;
}

.detail-section-gap {
  margin-bottom: 18px;
}

.detail-empty {
  padding: 24px 12px;
}
</style>
