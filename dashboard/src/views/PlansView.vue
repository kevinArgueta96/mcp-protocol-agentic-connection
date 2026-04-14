<template>
  <div class="app-shell">
    <AppHeader />
    <div class="app-frame plans-grid">

      <!-- ── Left: Plan list ────────────────────────────────────────────────── -->
      <div class="app-column plans-col-list">
        <div class="panel-header">
          <div class="panel-heading">
            <span class="panel-label">Plans</span>
            <span class="panel-sublabel">multi-agent orchestration</span>
          </div>
          <button class="btn-ghost" @click="createPlan">+ new</button>
        </div>

        <div v-if="plansStore.plans.length === 0" class="empty-state">
          <div class="empty-state__icon">◻</div>
          <p class="empty-state__title">No plans yet</p>
          <p class="empty-state__body">
            A plan is a sequence of prompts dispatched to different connected agents.
            Click <strong>+ new</strong> to start.
          </p>
        </div>

        <div v-else class="scrollable plan-list">
          <button
            v-for="plan in plansStore.plans"
            :key="plan.id"
            class="sig-card sig-card--button"
            :class="selectedPlanId === plan.id ? 'conversation-active' : ''"
            @click="selectedPlanId = plan.id"
          >
            <div class="plan-list-item__head">
              <span class="plan-list-item__name">{{ plan.name }}</span>
              <span class="chip chip-dim">{{ plan.steps.length }} step{{ plan.steps.length !== 1 ? 's' : '' }}</span>
            </div>
            <div class="plan-list-item__meta">created {{ formatRelativeTime(plan.createdAt) }}</div>
          </button>
        </div>
      </div>

      <!-- ── Right: Plan builder + runner ──────────────────────────────────── -->
      <div class="app-column plans-col-builder">
        <div v-if="!selectedPlan" class="empty-state">
          <div class="empty-state__icon">↗</div>
          <p class="empty-state__title">No plan selected</p>
          <p class="empty-state__body">Choose a plan from the left or create a new one to start building.</p>
        </div>

        <template v-else>
          <!-- Plan header -->
          <div class="panel-header">
            <div class="panel-heading plan-name-row">
              <input
                class="plan-name-input"
                :value="selectedPlan.name"
                placeholder="Plan name"
                @blur="renamePlan"
                @keydown.enter.exact.prevent="($event.target as HTMLInputElement).blur()"
              />
            </div>
            <div class="plan-header-actions">
              <button class="btn-ghost" @click="deletePlan(selectedPlan.id)">delete</button>
              <button
                v-if="!isRunning"
                class="btn-primary"
                :disabled="!canRun"
                @click="startRun"
              >
                run plan
              </button>
              <button v-else class="btn-ghost btn-danger" @click="cancelRun">cancel</button>
            </div>
          </div>

          <!-- Run status (when active) -->
          <div v-if="activeRun" class="run-status-bar">
            <span class="run-status-label">
              {{ isRunning ? 'Running…' : (activeRun.cancelled ? 'Cancelled' : 'Completed') }}
            </span>
            <span class="run-status-steps">
              {{ completedStepCount }} / {{ activeRun.steps.length }} steps
            </span>
          </div>

          <!-- Steps list -->
          <div class="scrollable steps-scroll">
            <div class="steps-container">
              <div v-if="selectedPlan.steps.length === 0" class="empty-state empty-state--compact">
                <p class="empty-state__title">No steps</p>
                <p class="empty-state__body">Add steps below to define the agent sequence.</p>
              </div>

              <div
                v-for="(step, index) in selectedPlan.steps"
                :key="step.id"
                class="step-card"
                :class="stepCardClass(step.id)"
              >
                <!-- Step header -->
                <div class="step-header">
                  <span class="step-index">{{ index + 1 }}</span>
                  <input
                    class="step-title-input"
                    :value="step.title"
                    placeholder="Step title"
                    @blur="(e) => updateStepField(step.id, 'title', (e.target as HTMLInputElement).value)"
                    @keydown.enter.exact.prevent="($event.target as HTMLInputElement).blur()"
                  />
                  <span v-if="stepRunState(step.id)" class="chip" :class="stepStateChipClass(step.id)">
                    {{ stepRunState(step.id) }}
                  </span>
                  <div class="step-reorder">
                    <button class="step-reorder-btn" :disabled="index === 0" title="Move up" @click="moveStep(index, -1)">↑</button>
                    <button class="step-reorder-btn" :disabled="index === selectedPlan.steps.length - 1" title="Move down" @click="moveStep(index, 1)">↓</button>
                  </div>
                  <button class="btn-ghost btn-xs" @click="removeStep(step.id)">×</button>
                </div>

                <!-- Step body -->
                <div class="step-body">
                  <!-- Target agent -->
                  <div class="step-field">
                    <label class="step-field-label">Send to</label>
                    <div class="select-wrap">
                      <select
                        class="sig-select sig-select--sm"
                        :value="step.targetAgentId"
                        :disabled="isRunning"
                        @change="(e) => updateStepField(step.id, 'targetAgentId', (e.target as HTMLSelectElement).value)"
                      >
                        <option value="">— select agent —</option>
                        <option
                          v-for="agent in clientAgents"
                          :key="agent.agentId"
                          :value="agent.agentId"
                        >
                          {{ agent.projectName }} · {{ agent.clientInfo?.clientName ?? agent.name }}
                        </option>
                      </select>
                      <span class="select-caret">▾</span>
                    </div>
                  </div>

                  <!-- Wait condition -->
                  <div class="step-field step-field--inline">
                    <label class="step-field-label">Wait for</label>
                    <div class="select-wrap">
                      <select
                        class="sig-select sig-select--sm"
                        :value="step.waitFor"
                        :disabled="isRunning"
                        @change="(e) => updateStepField(step.id, 'waitFor', (e.target as HTMLSelectElement).value as PlanStep['waitFor'])"
                      >
                        <option value="answered">answered</option>
                        <option value="delivered">delivered to bridge</option>
                        <option value="none">fire and forget</option>
                      </select>
                      <span class="select-caret">▾</span>
                    </div>
                    <label class="step-field-label">Timeout</label>
                    <div class="select-wrap">
                      <select
                        class="sig-select sig-select--sm"
                        :value="String(step.timeoutMs)"
                        :disabled="isRunning"
                        @change="(e) => updateStepField(step.id, 'timeoutMs', Number((e.target as HTMLSelectElement).value))"
                      >
                        <option value="30000">30s</option>
                        <option value="60000">1m</option>
                        <option value="120000">2m</option>
                        <option value="300000">5m</option>
                        <option value="600000">10m</option>
                      </select>
                      <span class="select-caret">▾</span>
                    </div>
                  </div>

                  <!-- Prompt -->
                  <div class="step-field">
                    <label class="step-field-label">Prompt</label>
                    <textarea
                      class="step-prompt-textarea"
                      rows="3"
                      :value="step.prompt"
                      placeholder="The message to send to the agent…"
                      :disabled="isRunning"
                      @blur="(e) => updateStepField(step.id, 'prompt', (e.target as HTMLTextAreaElement).value)"
                    />
                  </div>

                  <!-- Step run result (if any) -->
                  <div v-if="stepRunStatus(step.id)" class="step-run-result">
                    <span v-if="stepRunStatus(step.id)?.conversationId" class="step-conv-link">
                      thread:
                      <RouterLink
                        :to="{ name: 'inbox', query: { conv: stepRunStatus(step.id)!.conversationId } }"
                        class="inline-link"
                      >
                        {{ stepRunStatus(step.id)!.conversationId!.slice(0, 8) }}…
                      </RouterLink>
                    </span>
                    <p v-if="stepRunStatus(step.id)?.responsePreview" class="step-response-preview">
                      {{ stepRunStatus(step.id)!.responsePreview }}
                    </p>
                    <span v-if="stepRunStatus(step.id)?.errorDetail" class="step-error">
                      {{ stepRunStatus(step.id)!.errorDetail }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- Add step button -->
              <button class="add-step-btn" :disabled="isRunning" @click="addStep">
                + add step
              </button>
            </div>
          </div>
        </template>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import AppHeader from "@/components/layout/AppHeader.vue";
import { usePlansStore, type PlanStep } from "@/stores/plans";
import { useRegistryStore } from "@/stores/registry";
import { PlanRunner, createPlanRun } from "@/lib/plan-runner";
import { formatRelativeTime } from "@/lib/utils";

const plansStore = usePlansStore();
const registryStore = useRegistryStore();

const selectedPlanId = ref<string | null>(null);

let runner: PlanRunner | null = null;

// ── Computed ──────────────────────────────────────────────────────────────────

const selectedPlan = computed(() =>
  selectedPlanId.value ? plansStore.getPlan(selectedPlanId.value) ?? null : null,
);

const clientAgents = computed(() =>
  registryStore.agentList.filter(
    (a) =>
      a.entryType === "client" &&
      a.agentId !== registryStore.dashboardClientId &&
      a.clientInfo?.clientVersion !== "app-server-bridge",
  ),
);

const activeRun = computed(() => plansStore.activeRun);

const isRunning = computed(
  () => !!activeRun.value && !activeRun.value.completedAt && !activeRun.value.cancelled,
);

const canRun = computed(
  () =>
    !!selectedPlan.value &&
    selectedPlan.value.steps.length > 0 &&
    selectedPlan.value.steps.every((s) => s.targetAgentId && s.prompt.trim()),
);

const completedStepCount = computed(() => {
  if (!activeRun.value) return 0;
  return activeRun.value.steps.filter((s) => s.state === "answered" || s.state === "failed" || s.state === "skipped").length;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function stepRunStatus(stepId: string) {
  return activeRun.value?.steps.find((s) => s.stepId === stepId) ?? null;
}

function stepRunState(stepId: string) {
  return stepRunStatus(stepId)?.state ?? null;
}

function stepCardClass(stepId: string): string {
  const state = stepRunState(stepId);
  if (state === "running") return "step-card--running";
  if (state === "answered") return "step-card--done";
  if (state === "failed") return "step-card--failed";
  return "";
}

function stepStateChipClass(stepId: string): string {
  const state = stepRunState(stepId);
  if (state === "running") return "chip-amber";
  if (state === "answered") return "chip-emerald";
  if (state === "failed") return "chip-red";
  return "chip-dim";
}

// ── Plan management ───────────────────────────────────────────────────────────

function createPlan() {
  const plan = plansStore.createPlan("New plan");
  selectedPlanId.value = plan.id;
}

function deletePlan(planId: string) {
  plansStore.deletePlan(planId);
  if (selectedPlanId.value === planId) selectedPlanId.value = null;
  if (activeRun.value?.planId === planId) plansStore.setActiveRun(null);
}

function renamePlan(e: Event) {
  if (!selectedPlan.value) return;
  const name = (e.target as HTMLInputElement).value.trim();
  if (name) plansStore.updatePlan(selectedPlan.value.id, { name });
}

function addStep() {
  if (!selectedPlan.value) return;
  plansStore.addStep(selectedPlan.value.id);
}

function removeStep(stepId: string) {
  if (!selectedPlan.value) return;
  plansStore.removeStep(selectedPlan.value.id, stepId);
}

function updateStepField<K extends keyof PlanStep>(stepId: string, field: K, value: PlanStep[K]) {
  if (!selectedPlan.value) return;
  plansStore.updateStep(selectedPlan.value.id, stepId, { [field]: value } as Partial<PlanStep>);
}

function moveStep(index: number, direction: -1 | 1) {
  if (!selectedPlan.value) return;
  const steps = [...selectedPlan.value.steps];
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= steps.length) return;
  const [moved] = steps.splice(index, 1);
  steps.splice(newIndex, 0, moved!);
  plansStore.reorderSteps(selectedPlan.value.id, steps);
}

// ── Run management ────────────────────────────────────────────────────────────

async function startRun() {
  if (!selectedPlan.value || !canRun.value) return;
  const plan = selectedPlan.value;
  const run = createPlanRun(plan);
  plansStore.setActiveRun(run);

  runner = new PlanRunner({
    onStepUpdate(stepId, update) {
      plansStore.updateStepRun(run.runId, stepId, update);
    },
    onRunComplete(finalRun) {
      plansStore.setActiveRun(finalRun);
      runner = null;
    },
  });

  await runner.run(plan, run);
}

function cancelRun() {
  runner?.cancel();
  plansStore.cancelActiveRun();
  runner = null;
}
</script>

<style scoped>
.plans-grid {
  display: grid;
  grid-template-columns: 28% 1fr;
  gap: 0;
  flex: 1;
  min-height: 0;
}

.plans-col-list,
.plans-col-builder {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* Plan list */
.plan-list-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.plan-list-item__name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-list-item__meta {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  color: rgba(255, 247, 237, 0.4);
  margin-top: 6px;
}

/* Plan name input */
.plan-name-row {
  flex: 1;
}

.plan-name-input {
  background: none;
  border: none;
  color: var(--text);
  font-size: 1rem;
  font-weight: 600;
  padding: 0;
  width: 100%;
  outline: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.15s;
}

.plan-name-input:focus {
  border-bottom-color: var(--border-strong);
}

.plan-header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}

/* Run status bar */
.run-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: rgba(185, 130, 255, 0.08);
  border-bottom: 1px solid rgba(185, 130, 255, 0.2);
  gap: 12px;
}

.run-status-label {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--violet);
  font-weight: 600;
}

.run-status-steps {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--text-dim);
}

/* Steps */
.steps-scroll {
  flex: 1;
}

.steps-container {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.step-card {
  background: rgba(35, 27, 22, 0.7);
  border: 1px solid var(--border-dim);
  border-radius: 10px;
  padding: 12px 14px;
  transition: border-color 0.2s;
}

.step-card--running {
  border-color: var(--amber);
  box-shadow: 0 0 12px rgba(255, 197, 108, 0.15);
}

.step-card--done {
  border-color: var(--emerald);
}

.step-card--failed {
  border-color: var(--red);
}

.step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.step-index {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  color: var(--text-ghost);
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.step-title-input {
  flex: 1;
  background: none;
  border: none;
  color: var(--text);
  font-size: 0.85rem;
  font-weight: 500;
  padding: 0;
  outline: none;
  border-bottom: 1px solid transparent;
  min-width: 0;
  transition: border-color 0.15s;
}

.step-title-input:focus {
  border-bottom-color: var(--border-mid);
}

.step-reorder {
  display: flex;
  gap: 2px;
}

.step-reorder-btn {
  background: none;
  border: 1px solid var(--border-dim);
  color: var(--text-dim);
  padding: 2px 5px;
  border-radius: 4px;
  font-size: 0.65rem;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.step-reorder-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-mid);
}

.step-reorder-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.step-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.step-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-field--inline {
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.step-field-label {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  color: var(--text-ghost);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.step-prompt-textarea {
  width: 100%;
  min-height: 58px;
  resize: vertical;
  background: rgba(20, 15, 12, 0.5);
  border: 1px solid var(--border-dim);
  border-radius: 6px;
  color: var(--text);
  padding: 6px 8px;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.5;
  transition: border-color 0.15s;
}

.step-prompt-textarea:focus {
  outline: none;
  border-color: var(--border-mid);
}

.step-run-result {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.step-conv-link {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  color: var(--text-dim);
}

.step-response-preview {
  margin: 0;
  font-size: 0.75rem;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.45;
  padding: 6px 8px;
  background: rgba(116, 227, 156, 0.06);
  border: 1px solid rgba(116, 227, 156, 0.15);
  border-radius: 6px;
  max-height: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.step-error {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--red);
}

/* Add step button */
.add-step-btn {
  background: none;
  border: 1px dashed var(--border-mid);
  border-radius: 10px;
  color: var(--text-dim);
  padding: 10px 16px;
  font-size: 0.82rem;
  cursor: pointer;
  text-align: center;
  transition: border-color 0.15s, color 0.15s;
}

.add-step-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.add-step-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Primary button */
.btn-primary {
  background: var(--violet);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-danger {
  color: var(--red);
}

.btn-xs {
  font-size: 0.65rem;
  padding: 2px 7px;
}

.sig-select--sm {
  font-size: 0.78rem;
  padding: 3px 24px 3px 8px;
}

.empty-state--compact {
  padding: 16px 0;
}

.inline-link {
  color: var(--violet);
  text-decoration: underline;
}
</style>
