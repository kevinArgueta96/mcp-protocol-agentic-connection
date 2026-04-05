import { computed, ref } from "vue";
import { randomUUID } from "@/lib/utils";
import type { DashboardClientProfile } from "@/lib/dashboard-client-profile";
import { DefaultDashboardClientProfileResolver } from "@/lib/dashboard-client-profile-resolver";
import { dashboardChannelRuntime } from "@/lib/channel-runtime";
import type { ChannelAckPayload, ChannelMessagePayload, ChatMessage, RegistryAgent } from "@/types";

const DASHBOARD_AGENT_ID = dashboardChannelRuntime.clientId;

export class ChannelChatSession {
  private readonly profileResolver = new DefaultDashboardClientProfileResolver();
  private readonly clientProfile: DashboardClientProfile;
  readonly messages = ref<ChatMessage[]>([]);
  readonly selectedClient = ref<RegistryAgent | null>(null);
  readonly activeConversationId = ref<string | null>(null);
  readonly isStreaming = ref(false);
  readonly error = ref<string | null>(null);
  readonly selectedConversationId = computed(() => this.activeConversationId.value);

  private readonly stopChannelMessageListener: () => void;
  private readonly stopChannelAckListener: () => void;

  constructor() {
    this.clientProfile = this.profileResolver.resolve({ clientName: "dashboard" });
    this.stopChannelMessageListener = dashboardChannelRuntime.on("channelMessage", (message) => {
      this.handleChannelMessage(message);
    });
    this.stopChannelAckListener = dashboardChannelRuntime.on("channelAck", (ack) => {
      this.handleChannelAck(ack);
    });
  }

  selectClient(agent: RegistryAgent | null): void {
    this.selectedClient.value = agent;
    this.activeConversationId.value = null;
    this.messages.value = [];
    this.error.value = null;
    this.isStreaming.value = false;
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.selectedClient.value || this.isStreaming.value || !text.trim()) return;

    this.isStreaming.value = true;
    this.error.value = null;

    const latestMessage = this.messages.value.at(-1);
    const replyTo = latestMessage?.messageId;

    try {
      const message = await dashboardChannelRuntime.sendMessage({
        conversationId: this.activeConversationId.value ?? undefined,
        replyTo,
        toAgentId: this.selectedClient.value.agentId,
        content: text.trim(),
        expectsResponse: true,
        requiresAck: true,
        expiresAt: Date.now() + 300_000,
        meta: {
          targetClientId: this.selectedClient.value.agentId,
          targetProject: this.selectedClient.value.projectPath,
          source: "dashboard-chat",
        },
      });

      this.activeConversationId.value = message.conversationId;
      this.upsertMessage({
        ...this.clientProfile.toChatMessage(message, DASHBOARD_AGENT_ID),
        deliveryState: "queued",
      });
    } catch (err) {
      this.error.value = err instanceof Error ? err.message : String(err);
      this.messages.value = [
        ...this.messages.value,
        {
          id: randomUUID(),
          role: "system",
          content: `Channel send failed: ${this.error.value}`,
          timestamp: new Date().toISOString(),
        },
      ];
      this.isStreaming.value = false;
    }
  }

  async sendReminder(): Promise<void> {
    if (!this.selectedClient.value || this.isStreaming.value || !this.activeConversationId.value) return;

    const latestMessage = this.messages.value.at(-1);
    const reminderTarget = [...this.messages.value].reverse().find((message) => message.role === "agent") ?? latestMessage;
    const replyTo = reminderTarget?.messageId;
    const clientLabel = this.selectedClient.value.clientInfo?.clientName ?? this.selectedClient.value.name;
    const reminderText =
      `Reminder for ${clientLabel}: you have a pending channel conversation. ` +
      "Review the latest message and reply in the same thread to continue.";

    this.isStreaming.value = true;
    this.error.value = null;

    try {
      const message = await dashboardChannelRuntime.sendMessage({
        conversationId: this.activeConversationId.value,
        replyTo,
        toAgentId: this.selectedClient.value.agentId,
        content: reminderText,
        expectsResponse: true,
        requiresAck: true,
        expiresAt: Date.now() + 300_000,
        meta: {
          targetClientId: this.selectedClient.value.agentId,
          targetProject: this.selectedClient.value.projectPath,
          source: "dashboard-chat-reminder",
          reminder: true,
        },
      });

      this.upsertMessage({
        ...this.clientProfile.toChatMessage(message, DASHBOARD_AGENT_ID),
        deliveryState: "queued",
      });
    } catch (err) {
      this.error.value = err instanceof Error ? err.message : String(err);
      this.messages.value = [
        ...this.messages.value,
        {
          id: randomUUID(),
          role: "system",
          content: `Reminder send failed: ${this.error.value}`,
          timestamp: new Date().toISOString(),
        },
      ];
      this.isStreaming.value = false;
    }
  }

  clear(): void {
    this.messages.value = [];
    this.activeConversationId.value = null;
    this.error.value = null;
    this.isStreaming.value = false;
  }

  destroy(): void {
    this.stopChannelMessageListener();
    this.stopChannelAckListener();
  }

  private handleChannelMessage(message: ChannelMessagePayload): void {
    if (!this.selectedClient.value) return;
    if (!this.clientProfile.matchesClientConversation(message, DASHBOARD_AGENT_ID, this.selectedClient.value.agentId)) return;

    if (this.activeConversationId.value && message.conversationId !== this.activeConversationId.value) {
      return;
    }

    if (!this.activeConversationId.value) {
      this.activeConversationId.value = message.conversationId;
    }

    this.upsertMessage(this.clientProfile.toChatMessage(message, DASHBOARD_AGENT_ID));
    this.isStreaming.value = false;
    this.error.value = null;
  }

  private handleChannelAck(ack: ChannelAckPayload): void {
    this.messages.value = this.clientProfile.applyAck(
      this.messages.value,
      ack,
      this.activeConversationId.value,
    );

    if (ack.state === "failed" && this.activeConversationId.value === ack.conversationId) {
      this.error.value = ack.detail ?? "Channel delivery failed.";
      this.isStreaming.value = false;
    }
  }

  private upsertMessage(message: ChatMessage): void {
    const idx = message.messageId
      ? this.messages.value.findIndex((item) => item.messageId === message.messageId)
      : -1;

    if (idx === -1) {
      this.messages.value = [...this.messages.value, message];
      return;
    }

    this.messages.value = [
      ...this.messages.value.slice(0, idx),
      { ...this.messages.value[idx], ...message },
      ...this.messages.value.slice(idx + 1),
    ];
  }
}
