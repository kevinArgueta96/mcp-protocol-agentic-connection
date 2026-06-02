import { randomUUID } from "node:crypto";
import type { AgentMessage, ChannelMessage } from "../../types/messages.js";
import type {
  AcceptsChannelMessageContext,
  ClientBehaviorProfile,
  ClientNotificationEnvelope,
  LegacyNotifyPayload,
} from "../client-profile-resolver.js";

function buildAntigravityPayload(
  content: string,
  meta: Record<string, unknown>,
): ClientNotificationEnvelope {
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
  return `New channel message from ${source}.${conversation}${task} Antigravity handles channels as inbox-first state. Use channel_inbox to inspect it and reply.${preview}`;
}

/**
 * Behaviour profile for the Antigravity CLI (`agy`). Antigravity is an MCP
 * client, so the channels pattern is delivered as MCP notifications and the
 * agent discovers/answers messages via the open-agent-bridge tools — hence
 * `inbox-first`, matching the Gemini/Codex inner-client semantics.
 */
export class AntigravityClientProfile implements ClientBehaviorProfile {
  readonly id = "antigravity";
  readonly deliveryMode = "inbox-first" as const;

  acceptsChannelMessage(
    message: ChannelMessage,
    selfAgentId: string | null,
    ctx?: AcceptsChannelMessageContext,
  ): boolean {
    // Identity hard wall: a message is only visible inside its own namespace.
    if ((message.identity ?? "global") !== (ctx?.selfIdentity ?? "global")) return false;
    if (!message.toAgentId) return true;
    if (selfAgentId != null && message.toAgentId === selfAgentId) return true;
    if (ctx?.siblingBridgeAgentIds?.has(message.toAgentId)) return true;
    return false;
  }

  mapChannelMessage(message: ChannelMessage): ClientNotificationEnvelope {
    return buildAntigravityPayload(
      buildInboxReminder({
        fromAgentId: message.fromAgentId,
        fromAgentName: message.fromAgentName,
        conversationId: message.conversationId,
        content: message.content,
        taskId: message.taskId,
      }),
      {
        fromAgentId: message.fromAgentId,
        fromAgentName: message.fromAgentName,
        conversationId: message.conversationId,
        messageId: message.messageId,
        replyTo: message.replyTo,
        taskId: message.taskId,
        kind: message.kind,
        ...message.meta,
      },
    );
  }

  mapLegacyNotify(payload: LegacyNotifyPayload): ClientNotificationEnvelope {
    return buildAntigravityPayload(
      buildInboxReminder({
        fromAgentId: payload.agentId,
        fromAgentName: payload.agentName,
        conversationId: payload.conversationId,
        content: payload.content,
      }),
      {
        fromAgentId: payload.agentId,
        fromAgentName: payload.agentName,
        conversationId: payload.conversationId ?? randomUUID(),
        messageId: payload.messageId ?? randomUUID(),
        ...payload.meta,
      },
    );
  }

  mapTaskRequestMessage(message: AgentMessage): ClientNotificationEnvelope | null {
    if (message.type !== "task.request") return null;
    const payload = message.payload as { message?: string; skillId?: string } | null;
    return buildAntigravityPayload(
      buildInboxReminder({
        fromAgentId: message.fromAgentId,
        conversationId: message.taskId,
        content: payload?.message ?? JSON.stringify(payload),
        taskId: message.taskId,
      }),
      {
        fromAgentId: message.fromAgentId,
        taskId: message.taskId,
        skillId: payload?.skillId,
        type: message.type,
      },
    );
  }
}
