import type { AgentMessage, ChannelMessage } from "../types/messages.js";
import { ClaudeClientProfile } from "./profiles/claude-client-profile.js";

export interface ClaudeChannelNotification {
  [key: string]: unknown;
  content: string;
  meta: Record<string, string>;
}

export interface LegacyNotifyPayload {
  agentId?: string;
  agentName?: string;
  content: string;
  meta?: Record<string, unknown>;
  conversationId?: string;
  messageId?: string;
}

export interface ClientBehaviorProfile {
  id: string;
  acceptsChannelMessage(message: ChannelMessage, selfAgentId: string | null): boolean;
  mapChannelMessage(message: ChannelMessage): ClaudeChannelNotification;
  mapLegacyNotify(payload: LegacyNotifyPayload): ClaudeChannelNotification;
  mapTaskRequestMessage(message: AgentMessage): ClaudeChannelNotification | null;
}

export interface ResolveClientProfileInput {
  clientName: string;
}

export interface ClientProfileResolver {
  resolve(input: ResolveClientProfileInput): ClientBehaviorProfile;
}

export class DefaultClientProfileResolver implements ClientProfileResolver {
  private readonly claudeProfile = new ClaudeClientProfile();

  resolve(input: ResolveClientProfileInput): ClientBehaviorProfile {
    const normalized = input.clientName.toLowerCase();

    if (normalized === "claude-code" || normalized === "claude") {
      return this.claudeProfile;
    }

    return this.claudeProfile;
  }
}
