import type { ChannelAck } from "../types/messages.js";
import type { RegistryClient } from "./registry-client.js";

/** A channel message awaiting a response from a given client. */
export interface PendingChannelMessage {
  conversationId: string;
  messageId: string;
  fromAgentId: string;
  fromAgentName?: string;
  taskId?: string;
  content: string;
  createdAt: number;
}

function latestAckByMessage(acks: ChannelAck[]): Map<string, ChannelAck> {
  const latest = new Map<string, ChannelAck>();
  for (const ack of acks) latest.set(ack.messageId, ack);
  return latest;
}

/**
 * Collect every pending (response-expecting, not-yet-handled) channel message
 * addressed to `clientId` (or broadcast). Used by the Antigravity hook commands
 * to decide whether to block the
 * Stop and what to surface in `.agents/ORIGINAL_REQUEST.md`.
 */
export async function collectPendingForClient(
  registry: RegistryClient,
  clientId: string,
): Promise<PendingChannelMessage[]> {
  const list = await registry.listChannelConversations({ pendingOnly: true });
  const pending: PendingChannelMessage[] = [];

  for (const entry of list) {
    const snapshot = await registry.getChannelConversation(entry.conversationId);
    if (!snapshot) continue;

    const ackMap = latestAckByMessage(snapshot.acknowledgements);
    for (const message of snapshot.messages) {
      if (!message.expectsResponse) continue;
      if (message.toAgentId && message.toAgentId !== clientId) continue;
      const ack = ackMap.get(message.messageId);
      if (ack?.state === "displayed_to_client" || ack?.state === "answered" || ack?.state === "failed") {
        continue;
      }
      pending.push({
        conversationId: snapshot.conversationId,
        messageId: message.messageId,
        fromAgentId: message.fromAgentId,
        fromAgentName: message.fromAgentName,
        taskId: message.taskId,
        content: message.content,
        createdAt: message.createdAt,
      });
    }
  }

  return pending;
}
