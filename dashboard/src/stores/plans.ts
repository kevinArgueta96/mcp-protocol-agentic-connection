import { defineStore } from "pinia";
import { ref } from "vue";
import { randomUUID } from "@/lib/utils";

export interface PlanStep {
  id: string;
  title: string;
  prompt: string;
  targetAgentId: string;
  waitFor: "answered" | "delivered" | "none";
  timeoutMs: number;
}

export interface Plan {
  id: string;
  name: string;
  steps: PlanStep[];
  createdAt: number;
}

export type StepRunState = "pending" | "running" | "answered" | "failed" | "skipped";

export interface StepRunStatus {
  stepId: string;
  state: StepRunState;
  conversationId?: string;
  responsePreview?: string;
  errorDetail?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface PlanRun {
  runId: string;
  planId: string;
  planName: string;
  steps: StepRunStatus[];
  startedAt: number;
  completedAt?: number;
  cancelled: boolean;
}

const STORAGE_KEY = "agent-bridge:plans:v1";

function loadPlans(): Plan[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Plan[]) : [];
  } catch {
    return [];
  }
}

function savePlans(plans: Plan[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plans));
}

export const usePlansStore = defineStore("plans", () => {
  const plans = ref<Plan[]>(loadPlans());
  const activeRun = ref<PlanRun | null>(null);

  function persistPlans() {
    savePlans(plans.value);
  }

  function createPlan(name: string): Plan {
    const plan: Plan = {
      id: randomUUID(),
      name,
      steps: [],
      createdAt: Date.now(),
    };
    plans.value = [...plans.value, plan];
    persistPlans();
    return plan;
  }

  function updatePlan(planId: string, updates: Partial<Pick<Plan, "name" | "steps">>) {
    plans.value = plans.value.map((p) => (p.id === planId ? { ...p, ...updates } : p));
    persistPlans();
  }

  function deletePlan(planId: string) {
    plans.value = plans.value.filter((p) => p.id !== planId);
    persistPlans();
  }

  function addStep(planId: string, step?: Partial<PlanStep>): PlanStep {
    const newStep: PlanStep = {
      id: randomUUID(),
      title: step?.title ?? "New step",
      prompt: step?.prompt ?? "",
      targetAgentId: step?.targetAgentId ?? "",
      waitFor: step?.waitFor ?? "answered",
      timeoutMs: step?.timeoutMs ?? 120_000,
    };
    plans.value = plans.value.map((p) =>
      p.id === planId ? { ...p, steps: [...p.steps, newStep] } : p,
    );
    persistPlans();
    return newStep;
  }

  function updateStep(planId: string, stepId: string, updates: Partial<PlanStep>) {
    plans.value = plans.value.map((p) => {
      if (p.id !== planId) return p;
      return {
        ...p,
        steps: p.steps.map((s) => (s.id === stepId ? { ...s, ...updates } : s)),
      };
    });
    persistPlans();
  }

  function removeStep(planId: string, stepId: string) {
    plans.value = plans.value.map((p) => {
      if (p.id !== planId) return p;
      return { ...p, steps: p.steps.filter((s) => s.id !== stepId) };
    });
    persistPlans();
  }

  function reorderSteps(planId: string, newSteps: PlanStep[]) {
    plans.value = plans.value.map((p) => (p.id === planId ? { ...p, steps: newSteps } : p));
    persistPlans();
  }

  function setActiveRun(run: PlanRun | null) {
    activeRun.value = run;
  }

  function updateStepRun(runId: string, stepId: string, update: Partial<StepRunStatus>) {
    if (!activeRun.value || activeRun.value.runId !== runId) return;
    activeRun.value = {
      ...activeRun.value,
      steps: activeRun.value.steps.map((s) => (s.stepId === stepId ? { ...s, ...update } : s)),
    };
  }

  function cancelActiveRun() {
    if (!activeRun.value) return;
    activeRun.value = { ...activeRun.value, cancelled: true, completedAt: Date.now() };
  }

  function getPlan(planId: string): Plan | undefined {
    return plans.value.find((p) => p.id === planId);
  }

  return {
    plans,
    activeRun,
    createPlan,
    updatePlan,
    deletePlan,
    addStep,
    updateStep,
    removeStep,
    reorderSteps,
    setActiveRun,
    updateStepRun,
    cancelActiveRun,
    getPlan,
  };
});
