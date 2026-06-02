/** Conversation status as computed by ConversationService. */
export type ClearableStatus = "pending" | "answered" | "failed" | "expired" | "active";

export interface ClearableConversation {
  conversationId: string;
  status: ClearableStatus;
}

/** Scope for channel_clear: a well-known bucket or an explicit conversationId. */
export type ClearScope = "answered" | "failed" | "all" | (string & {});

/**
 * Decide which of the agent's tracked conversations to clear for a given scope.
 *
 * - "answered" → only answered threads.
 * - "failed"   → failed + locally-expired threads.
 * - "all"      → every NON-pending thread (answered/failed/expired/active);
 *                never clears still-unanswered ("pending") work in bulk.
 * - <id>       → exactly that conversation, even if pending (explicit intent).
 *
 * Pure function — safe to unit test.
 */
export function selectConversationsToClear(
  conversations: ReadonlyArray<ClearableConversation>,
  scope: ClearScope,
): string[] {
  switch (scope) {
    case "answered":
      return conversations.filter((c) => c.status === "answered").map((c) => c.conversationId);
    case "failed":
      return conversations
        .filter((c) => c.status === "failed" || c.status === "expired")
        .map((c) => c.conversationId);
    case "all":
      return conversations.filter((c) => c.status !== "pending").map((c) => c.conversationId);
    default:
      // Treat as an explicit conversationId.
      return conversations.some((c) => c.conversationId === scope) ? [scope] : [];
  }
}
