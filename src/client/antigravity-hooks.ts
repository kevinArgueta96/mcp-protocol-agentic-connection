/**
 * Pure builders for Antigravity CLI hook stdout payloads.
 *
 * Antigravity hooks read JSON from stdin and write JSON to stdout (camelCase).
 * - The `Stop` hook can return {"decision":"block","reason":...} to force the
 *   agent to continue with `reason` fed back as input — our auto-arrival trigger.
 * - The `SessionStart` hook can inject `hookSpecificOutput.additionalContext`
 *   (model-visible) without blocking.
 *
 * Keeping these pure makes the delivery decision testable in isolation from the
 * registry I/O performed by the CLI hook command.
 */

export interface PendingMessageSummary {
  fromAgentName?: string;
  fromAgentId?: string;
  content?: string;
  conversationId?: string;
}

export interface StopHookOutput {
  decision?: "block";
  reason?: string;
}

export interface SessionStartHookOutput {
  hookSpecificOutput?: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
}

/**
 * Build the `Stop` hook output. When messages are pending, block the stop and
 * instruct the agent to read its inbox and reply. Empty object = allow stop.
 */
export function buildStopHookOutput(pending: PendingMessageSummary[]): StopHookOutput {
  if (pending.length === 0) return {};

  const senders = [
    ...new Set(pending.map((p) => p.fromAgentName ?? p.fromAgentId ?? "unknown")),
  ].join(", ");

  const reason =
    `You have ${pending.length} pending open-agent-bridge channel message(s) from: ${senders}. ` +
    "Do not stop yet. Call channel_inbox(pendingOnly=true) to read them, then answer each with the " +
    "reply tool. The latest message(s) were also appended to .agents/ORIGINAL_REQUEST.md.";

  return { decision: "block", reason };
}

/**
 * Build the `SessionStart` hook output. When messages are waiting, surface a
 * non-blocking context note so the agent knows to check the channel.
 */
export function buildSessionStartHookOutput(pendingCount: number): SessionStartHookOutput {
  if (pendingCount <= 0) return {};

  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `open-agent-bridge: ${pendingCount} pending channel message(s) for this session. ` +
        "Call channel_inbox(pendingOnly=true) to read and reply to them.",
    },
  };
}
