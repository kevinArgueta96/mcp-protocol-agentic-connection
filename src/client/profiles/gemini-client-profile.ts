import { randomUUID } from "node:crypto";
import type { AgentMessage, ChannelMessage } from "../../types/messages.js";
import type { ClientBehaviorProfile, ClientNotificationEnvelope, LegacyNotifyPayload } from "../client-profile-resolver.js";

function buildGeminiPayload(content: string, meta: Record<string, unknown>): ClientNotificationEnvelope {
  return {
    method: "notifications/message",
    params: {
      level: "info",
      logger: "agent-bridge.channel",
      data: {
        content,
        meta,
      },
    },
  };
}

function buildInboxReminder(input: {
  fromAgentId?: string;
  fromAgentName?: string;
  conversationId?: string;
  content?: string;
  taskId?: string;
}): string {
  const source = input.fromAgentName ?? input.fromAgentId ?? "unknown sender";
  const preview = input.content?.trim()
    ? ` Preview: ${input.content.trim().slice(0, 160)}${input.content.trim().length > 160 ? "…" : ""}`
    : "";
  const conversation = input.conversationId ? ` Conversation: ${input.conversationId}.` : "";
  const task = input.taskId ? ` Task: ${input.taskId}.` : "";
  return `New channel message from ${source}.${conversation}${task} Gemini handles channels as inbox-first state. Use channel_inbox to inspect it and reply.${preview}`;
}

export class GeminiClientProfile implements ClientBehaviorProfile {
  readonly id = "gemini";
  readonly deliveryMode = "inbox-first" as const;

  acceptsChannelMessage(message: ChannelMessage, selfAgentId: string | null): boolean {
    return !message.toAgentId || (selfAgentId != null && message.toAgentId === selfAgentId);
  }

  mapChannelMessage(message: ChannelMessage): ClientNotificationEnvelope {
    return buildGeminiPayload(buildInboxReminder({
      fromAgentId: message.fromAgentId,
      fromAgentName: message.fromAgentName,
      conversationId: message.conversationId,
      content: message.content,
      taskId: message.taskId,
    }), {
      fromAgentId: message.fromAgentId,
      fromAgentName: message.fromAgentName,
      conversationId: message.conversationId,
      messageId: message.messageId,
      replyTo: message.replyTo,
      taskId: message.taskId,
      kind: message.kind,
      ...message.meta,
    });
  }

  mapLegacyNotify(payload: LegacyNotifyPayload): ClientNotificationEnvelope {
    return buildGeminiPayload(buildInboxReminder({
      fromAgentId: payload.agentId,
      fromAgentName: payload.agentName,
      conversationId: payload.conversationId,
      content: payload.content,
    }), {
      fromAgentId: payload.agentId,
      fromAgentName: payload.agentName,
      conversationId: payload.conversationId ?? randomUUID(),
      messageId: payload.messageId ?? randomUUID(),
      ...payload.meta,
    });
  }

  mapTaskRequestMessage(message: AgentMessage): ClientNotificationEnvelope | null {
    if (message.type !== "task.request") return null;
    const payload = message.payload as { message?: string; skillId?: string } | null;
    return buildGeminiPayload(buildInboxReminder({
      fromAgentId: message.fromAgentId,
      conversationId: message.taskId,
      content: payload?.message ?? JSON.stringify(payload),
      taskId: message.taskId,
    }), {
      fromAgentId: message.fromAgentId,
      taskId: message.taskId,
      skillId: payload?.skillId,
      type: message.type,
    });
  }
}
