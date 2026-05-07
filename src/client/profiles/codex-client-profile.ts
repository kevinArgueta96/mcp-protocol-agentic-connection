import { randomUUID } from "node:crypto";
import type { AgentMessage, ChannelMessage } from "../../types/messages.js";
import type {
  AcceptsChannelMessageContext,
  ClientBehaviorProfile,
  ClientNotificationEnvelope,
  LegacyNotifyPayload,
} from "../client-profile-resolver.js";

function buildCodexPayload(content: string, meta: Record<string, unknown>): ClientNotificationEnvelope {
  return {
    method: "notifications/message",
    params: {
      level: "info",
      logger: "open-agent-bridge.channel",
      data: {
        content,
        meta,
      },
    },
  };
}

export class CodexClientProfile implements ClientBehaviorProfile {
  readonly id = "codex";
  readonly deliveryMode = "push" as const;

  acceptsChannelMessage(
    message: ChannelMessage,
    selfAgentId: string | null,
    ctx?: AcceptsChannelMessageContext,
  ): boolean {
    if (!message.toAgentId) return true;
    if (selfAgentId != null && message.toAgentId === selfAgentId) return true;
    // Auto-redirect rewrites toAgentId to the sibling bridge daemon. The inner
    // MCP client must still surface the message so the agent can discover it
    // via channel_inbox(pendingOnly=true).
    if (ctx?.siblingBridgeAgentIds?.has(message.toAgentId)) return true;
    return false;
  }

  mapChannelMessage(message: ChannelMessage): ClientNotificationEnvelope {
    return buildCodexPayload(message.content, {
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
    return buildCodexPayload(payload.content, {
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
    const content = payload?.message ?? JSON.stringify(payload);
    return buildCodexPayload(content, {
      fromAgentId: message.fromAgentId,
      taskId: message.taskId,
      skillId: payload?.skillId,
      type: message.type,
    });
  }
}
