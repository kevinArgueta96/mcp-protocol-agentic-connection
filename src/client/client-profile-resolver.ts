import type { AgentMessage, ChannelMessage } from "../types/messages.js";
import { ClaudeClientProfile } from "./profiles/claude-client-profile.js";
import { CodexClientProfile } from "./profiles/codex-client-profile.js";
import { GeminiClientProfile } from "./profiles/gemini-client-profile.js";
import { OpenCodeClientProfile } from "./profiles/opencode-client-profile.js";

export interface ClientNotificationEnvelope {
  method: string;
  params: Record<string, unknown>;
}

export interface LegacyNotifyPayload {
  agentId?: string;
  agentName?: string;
  content: string;
  meta?: Record<string, unknown>;
  conversationId?: string;
  messageId?: string;
}

export interface AcceptsChannelMessageContext {
  /**
   * Set of agentIds belonging to bridge daemons that share the same project as
   * the inner MCP client. When the adapter rewrites `toAgentId` to a sibling
   * bridge via auto-redirect, the inner client must still accept the message
   * locally so it can surface in `channel_inbox(pendingOnly=true)`.
   */
  siblingBridgeAgentIds?: ReadonlySet<string>;
}

export interface ClientBehaviorProfile {
  id: string;
  deliveryMode: "push" | "inbox-first";
  acceptsChannelMessage(
    message: ChannelMessage,
    selfAgentId: string | null,
    ctx?: AcceptsChannelMessageContext,
  ): boolean;
  mapChannelMessage(message: ChannelMessage): ClientNotificationEnvelope | null;
  mapLegacyNotify(payload: LegacyNotifyPayload): ClientNotificationEnvelope | null;
  mapTaskRequestMessage(message: AgentMessage): ClientNotificationEnvelope | null;
}

export interface ResolveClientProfileInput {
  clientName: string;
}

export interface ClientProfileResolver {
  resolve(input: ResolveClientProfileInput): ClientBehaviorProfile;
}

export class DefaultClientProfileResolver implements ClientProfileResolver {
  private readonly claudeProfile = new ClaudeClientProfile();
  private readonly codexProfile = new CodexClientProfile();
  private readonly geminiProfile = new GeminiClientProfile();
  private readonly opencodeProfile = new OpenCodeClientProfile();

  resolve(input: ResolveClientProfileInput): ClientBehaviorProfile {
    const normalized = input.clientName.toLowerCase();

    if (normalized === "claude-code" || normalized === "claude") {
      return this.claudeProfile;
    }

    if (normalized === "gemini" || normalized === "gemini-cli") {
      return this.geminiProfile;
    }

    if (normalized === "codex" || normalized === "codex-cli" || normalized.includes("codex")) {
      return this.codexProfile;
    }

    if (normalized === "opencode" || normalized.includes("opencode")) {
      return this.opencodeProfile;
    }

    return this.codexProfile;
  }
}
