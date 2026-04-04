// Built-in skill: push a notification to the Claude terminal via claude/channel
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BaseSkill } from "../framework.js";
import type { SkillContext } from "../../types/skills.js";

const REGISTRY_URL = "http://localhost:4999";

const inputSchema = z.object({
  content: z.string().describe("Message content to push to the Claude terminal"),
  conversationId: z.string().optional().describe("Conversation ID to continue. Defaults to a new conversation."),
  replyTo: z.string().optional().describe("Message ID this message replies to"),
  requiresAck: z.boolean().optional().default(true).describe("Whether the sender expects delivery acknowledgements"),
  expectsResponse: z.boolean().optional().default(false).describe("Whether the sender expects a reply"),
  responseTimeoutMs: z.number().optional().default(300000).describe("How long to wait for a reply before expiring"),
  meta: z
    .record(z.unknown())
    .optional()
    .describe("Optional metadata to attach (e.g. skill name, task context)"),
});

const outputSchema = z.object({
  ok: z.boolean(),
  delivered: z.boolean(),
  registryUrl: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

export class NotifyClaudeSkill extends BaseSkill<Input, Output> {
  readonly id = "notify-claude";
  readonly name = "Notify Claude";
  readonly description =
    "Push a notification to the Claude terminal using the claude/channel protocol. " +
    "The message appears as a channel event in Claude Code, letting Claude see it and optionally reply back.";
  readonly tags = ["notify", "channel", "claude", "push"];
  readonly inputSchema = inputSchema;

  async execute(input: Input, context: SkillContext): Promise<Output> {
    const conversationId = input.conversationId ?? randomUUID();
    const messageId = randomUUID();
    const body = {
      agentId: context.agentId,
      agentName: context.agentId,
      content: input.content,
      conversationId,
      messageId,
      replyTo: input.replyTo,
      taskId: context.taskId,
      expiresAt: input.expectsResponse ? Date.now() + (input.responseTimeoutMs ?? 300_000) : undefined,
      requiresAck: input.requiresAck,
      expectsResponse: input.expectsResponse,
      meta: input.meta,
    };

    context.log("info", `Pushing notification to Claude: ${input.content.slice(0, 80)}`);

    try {
      const response = await fetch(`${REGISTRY_URL}/notify-claude`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        context.log("error", `Registry returned ${response.status}: ${text}`);
        return { ok: false, delivered: false, registryUrl: REGISTRY_URL, conversationId, messageId };
      }

      context.log("info", "Notification delivered to registry");
      const data = await response.json() as { conversationId?: string; messageId?: string };
      return {
        ok: true,
        delivered: true,
        registryUrl: REGISTRY_URL,
        conversationId: data.conversationId ?? conversationId,
        messageId: data.messageId ?? messageId,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      context.log("error", `Failed to reach registry: ${msg}`);
      return { ok: false, delivered: false, registryUrl: REGISTRY_URL, conversationId, messageId };
    }
  }
}
