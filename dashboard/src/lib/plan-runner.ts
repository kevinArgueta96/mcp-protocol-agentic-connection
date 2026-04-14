/**
 * PlanRunner — sequential plan execution logic.
 *
 * Dispatches steps one at a time via createChannelMessage, then waits for the
 * expected ACK state (or a timeout) before advancing to the next step.
 * All side effects (Pinia store updates, WS events) are injected as callbacks
 * so this module stays framework-agnostic and easy to test.
 */
import { randomUUID } from "@/lib/utils";
import { createChannelMessage } from "@/lib/registry-client";
import { dashboardChannelRuntime } from "@/lib/channel-runtime";
import type { ChannelAckPayload } from "@/types";
import type { Plan, PlanRun, PlanStep, StepRunStatus } from "@/stores/plans";

export interface PlanRunnerCallbacks {
  onStepUpdate(stepId: string, update: Partial<StepRunStatus>): void;
  onRunComplete(run: PlanRun): void;
}

export class PlanRunner {
  private cancelled = false;
  private ackListeners: Array<(ack: ChannelAckPayload) => void> = [];
  private msgListeners: Array<(msg: ChannelMessagePayload) => void> = [];
  private stopAckListener: (() => void) | null = null;
  private stopMsgListener: (() => void) | null = null;

  constructor(private readonly callbacks: PlanRunnerCallbacks) {}

  async run(plan: Plan, run: PlanRun): Promise<void> {
    this.cancelled = false;

    // Subscribe to all channel acks and messages for correlation
    this.stopAckListener = dashboardChannelRuntime.on("channelAck", (ack) => {
      for (const listener of this.ackListeners) listener(ack);
    });
    this.stopMsgListener = dashboardChannelRuntime.on("channelMessage", (msg) => {
      for (const listener of this.msgListeners) listener(msg);
    });

    try {
      for (const step of plan.steps) {
        if (this.cancelled) break;

        const stepStatus = run.steps.find((s) => s.stepId === step.id);
        if (!stepStatus || stepStatus.state !== "pending") continue;

        await this.runStep(step, run.runId);

        if (this.cancelled) break;
      }
    } finally {
      this.stopAckListener?.();
      this.stopAckListener = null;
      this.ackListeners = [];
      this.stopMsgListener?.();
      this.stopMsgListener = null;
      this.msgListeners = [];
    }

    const finalRun: PlanRun = { ...run, completedAt: Date.now(), cancelled: this.cancelled };
    this.callbacks.onRunComplete(finalRun);
  }

  cancel(): void {
    this.cancelled = true;
  }

  private async runStep(step: PlanStep, runId: string): Promise<void> {
    this.callbacks.onStepUpdate(step.id, { state: "running", startedAt: Date.now() });

    const conversationId = randomUUID();

    try {
      const msg = await createChannelMessage({
        conversationId,
        fromAgentId: dashboardChannelRuntime.clientId,
        fromAgentName: "Dashboard (Plan)",
        toAgentId: step.targetAgentId,
        kind: "chat",
        content: step.prompt,
        expectsResponse: step.waitFor === "answered",
        requiresAck: step.waitFor !== "none",
        expiresAt: Date.now() + step.timeoutMs,
        meta: {
          planRunId: runId,
          planStepId: step.id,
          source: "plan-runner",
        },
      });

      this.callbacks.onStepUpdate(step.id, { conversationId: msg.conversationId });

      if (step.waitFor === "none") {
        this.callbacks.onStepUpdate(step.id, { state: "answered", completedAt: Date.now() });
        return;
      }

      await this.waitForAck(msg.conversationId, msg.messageId, step);
    } catch (err) {
      this.callbacks.onStepUpdate(step.id, {
        state: "failed",
        errorDetail: err instanceof Error ? err.message : String(err),
        completedAt: Date.now(),
      });
    }
  }

  private waitForAck(
    conversationId: string,
    messageId: string,
    step: PlanStep,
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let capturedPreview: string | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const settle = (state: "answered" | "failed", detail?: string) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.ackListeners = this.ackListeners.filter((l) => l !== ackListener);
        this.msgListeners = this.msgListeners.filter((l) => l !== msgListener);
        this.callbacks.onStepUpdate(step.id, {
          state,
          responsePreview: capturedPreview,
          errorDetail: detail,
          completedAt: Date.now(),
        });
        resolve();
      };

      // Capture the agent's reply content as preview
      const msgListener = (msg: ChannelMessagePayload) => {
        if (msg.conversationId !== conversationId) return;
        if (msg.fromAgentId === dashboardChannelRuntime.clientId) return; // skip our own
        capturedPreview = msg.content.slice(0, 200);
      };

      const ackListener = (ack: ChannelAckPayload) => {
        if (ack.conversationId !== conversationId || ack.messageId !== messageId) return;

        if (step.waitFor === "delivered" && ack.state === "delivered_to_bridge") {
          settle("answered");
          return;
        }

        if (ack.state === "answered") {
          settle("answered");
          return;
        }

        if (ack.state === "failed") {
          settle("failed", ack.detail ?? "delivery failed");
          return;
        }
      };

      this.ackListeners.push(ackListener);
      this.msgListeners.push(msgListener);

      timeoutHandle = setTimeout(() => {
        settle("failed", `timed out after ${step.timeoutMs}ms`);
      }, step.timeoutMs);
    });
  }
}

export function createPlanRun(plan: Plan): PlanRun {
  return {
    runId: randomUUID(),
    planId: plan.id,
    planName: plan.name,
    steps: plan.steps.map((s) => ({
      stepId: s.id,
      state: "pending",
    })),
    startedAt: Date.now(),
    cancelled: false,
  };
}
