import { randomUUID } from "node:crypto";
import type { AgentMessage, ChannelMessage } from "../../types/messages.js";
import type { ClientBehaviorProfile, ClaudeChannelNotification, LegacyNotifyPayload } from "../client-profile-resolver.js";

function stringifyMeta(meta?: Record<string, unknown>): Record<string, string> {
  if (!meta) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value != null) result[key] = String(value);
  }
  return result;
}

export class ClaudeClientProfile implements ClientBehaviorProfile {
  readonly id = "claude";

  acceptsChannelMessage(message: ChannelMessage, selfAgentId: string | null): boolean {
    return (
      !message.toAgentId ||
      message.toAgentId === "claude" ||
      (selfAgentId != null && message.toAgentId === selfAgentId)
    );
  }

  mapChannelMessage(message: ChannelMessage): ClaudeChannelNotification {
    return {
      content: message.content,
      meta: {
        from_agent: message.fromAgentId,
        ...(message.fromAgentName ? { agent_name: message.fromAgentName } : {}),
        conversation_id: message.conversationId,
        message_id: message.messageId,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        ...(message.taskId ? { task_id: message.taskId } : {}),
        kind: message.kind,
        ...stringifyMeta(message.meta),
      },
    };
  }

  mapLegacyNotify(payload: LegacyNotifyPayload): ClaudeChannelNotification {
    return {
      content: payload.content,
      meta: {
        ...(payload.agentId ? { from_agent: payload.agentId } : {}),
        ...(payload.agentName ? { agent_name: payload.agentName } : {}),
        conversation_id: payload.conversationId ?? randomUUID(),
        message_id: payload.messageId ?? randomUUID(),
        ...stringifyMeta(payload.meta),
      },
    };
  }

  mapTaskRequestMessage(message: AgentMessage): ClaudeChannelNotification | null {
    if (message.type !== "task.request") return null;
    const payload = message.payload as { message?: string; skillId?: string } | null;
    const rawMessage = payload?.message ?? "";
    const content = rawMessage || JSON.stringify(payload);
    return {
      content,
      meta: {
        from_agent: message.fromAgentId ?? "",
        task_id: message.taskId ?? "",
        ...(payload?.skillId ? { skill_id: payload.skillId } : {}),
      },
    };
  }
}
