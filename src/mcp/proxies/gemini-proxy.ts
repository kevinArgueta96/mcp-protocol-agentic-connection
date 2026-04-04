import type { AgentMessage, ChannelMessage } from "../../types/messages.js";
import type { ClientNotificationEnvelope } from "../../client/client-profile-resolver.js";
import type { ConversationService, ConversationSnapshot } from "../../client/conversation-service.js";

function buildEnvelope(content: string, meta: Record<string, unknown>): ClientNotificationEnvelope {
  return {
    method: "notifications/message",
    params: {
      level: "info",
      logger: "agent-bridge.gemini-proxy",
      data: {
        content,
        meta,
      },
    },
  };
}

function previewText(value: string, max = 220): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function buildThreadContext(snapshot: ConversationSnapshot, maxMessages = 3): string {
  const relevant = snapshot.messages.slice(-maxMessages);
  if (relevant.length === 0) return "";
  return relevant.map((message) => {
    const sender = message.fromAgentName ?? message.fromAgentId;
    return `- ${sender}: ${previewText(message.content, 140)}`;
  }).join("\n");
}

export class GeminiProxy {
  constructor(private readonly conversations: ConversationService) {}

  buildChannelNotification(message: ChannelMessage): ClientNotificationEnvelope {
    const snapshot = this.conversations.getSnapshot(message.conversationId);
    const threadContext = snapshot ? buildThreadContext(snapshot) : "";
    const sender = message.fromAgentName ?? message.fromAgentId;

    return buildEnvelope(
      [
        "[agent-bridge gemini proxy]",
        `New channel message from ${sender}.`,
        `Conversation: ${message.conversationId}`,
        message.taskId ? `Task: ${message.taskId}` : "",
        `Latest message: ${previewText(message.content)}`,
        threadContext ? `Recent thread:\n${threadContext}` : "",
        "Next step: use channel_inbox to inspect the full thread, then reply with the same conversationId/replyTo.",
      ].filter(Boolean).join("\n"),
      {
        type: "gemini-proxy-message",
        conversationId: message.conversationId,
        messageId: message.messageId,
        fromAgentId: message.fromAgentId,
        fromAgentName: message.fromAgentName,
        taskId: message.taskId,
        replyTo: message.replyTo,
      },
    );
  }

  buildPendingReminder(snapshot: ConversationSnapshot, message: ChannelMessage, pendingCount: number): ClientNotificationEnvelope {
    const sender = message.fromAgentName ?? message.fromAgentId;
    const threadContext = buildThreadContext(snapshot);
    return buildEnvelope(
      [
        "[agent-bridge gemini proxy]",
        pendingCount > 1
          ? `You have ${pendingCount} pending channel conversations.`
          : `Pending channel conversation from ${sender}.`,
        `Conversation: ${snapshot.conversation.conversationId}`,
        `Pending message: ${previewText(message.content)}`,
        threadContext ? `Recent thread:\n${threadContext}` : "",
        "Use channel_inbox to inspect and reply.",
      ].filter(Boolean).join("\n"),
      {
        type: "gemini-proxy-pending",
        conversationId: snapshot.conversation.conversationId,
        messageId: message.messageId,
        pendingCount,
        fromAgentId: message.fromAgentId,
        fromAgentName: message.fromAgentName,
        taskId: message.taskId,
      },
    );
  }

  buildActiveConversationNotification(
    snapshot: ConversationSnapshot,
    message: ChannelMessage,
  ): ClientNotificationEnvelope {
    const sender = message.fromAgentName ?? message.fromAgentId;
    const threadContext = buildThreadContext(snapshot);
    return buildEnvelope(
      [
        "[agent-bridge gemini proxy]",
        `New message in active conversation from ${sender}.`,
        `Conversation: ${snapshot.conversation.conversationId}`,
        `Message: ${previewText(message.content)}`,
        threadContext ? `Recent thread:\n${threadContext}` : "",
        "Use channel_inbox to inspect and reply.",
      ].filter(Boolean).join("\n"),
      {
        type: "gemini-proxy-active-message",
        conversationId: snapshot.conversation.conversationId,
        messageId: message.messageId,
        fromAgentId: message.fromAgentId,
        fromAgentName: message.fromAgentName,
        taskId: message.taskId,
      },
    );
  }

  buildTaskRequestNotification(message: AgentMessage): ClientNotificationEnvelope | null {
    if (message.type !== "task.request") return null;
    const payload = message.payload as { message?: string; skillId?: string } | null;
    return buildEnvelope(
      [
        "[agent-bridge gemini proxy]",
        `Incoming task request from ${message.fromAgentId}.`,
        message.taskId ? `Task: ${message.taskId}` : "",
        payload?.skillId ? `Skill: ${payload.skillId}` : "",
        `Message: ${previewText(payload?.message ?? JSON.stringify(payload ?? {}))}`,
        "Use channel_inbox or ask_agent/reply as appropriate.",
      ].filter(Boolean).join("\n"),
      {
        type: "gemini-proxy-task-request",
        fromAgentId: message.fromAgentId,
        taskId: message.taskId,
        skillId: payload?.skillId,
      },
    );
  }
}
