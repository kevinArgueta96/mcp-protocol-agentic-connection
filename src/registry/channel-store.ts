import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ChannelAck,
  ChannelConversationListEntry,
  ChannelConversationSnapshot,
  ChannelMessage,
} from "../types/messages.js";

function defaultDbPath(): string {
  return resolve(process.cwd(), ".open-agent-bridge", "registry.sqlite");
}

export class ChannelStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = defaultDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_messages (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_channel_messages_conversation
        ON channel_messages (conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS channel_acks (
        ack_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_channel_acks_conversation
        ON channel_acks (conversation_id, timestamp);

      CREATE TABLE IF NOT EXISTS channel_suppressed_conversations (
        conversation_id TEXT PRIMARY KEY,
        suppressed_at INTEGER NOT NULL
      );
    `);
  }

  /** Look up an existing message by id, regardless of conversation. */
  getMessage(messageId: string): ChannelMessage | undefined {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM channel_messages
      WHERE message_id = ?
    `).get(messageId) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as ChannelMessage) : undefined;
  }

  /** Create a new message, or return the existing one if its `messageId` is already
   *  persisted. The returned `created` flag tells the caller whether this was a fresh
   *  insert (and therefore needs to be broadcast) or a duplicate retry that the caller
   *  should silently dedup.
   *
   *  Idempotency is keyed on `messageId`. Senders that retry `POST /channel/messages`
   *  with the same explicit `messageId` will only see one broadcast and one row in
   *  `channel_messages`. */
  createMessage(input: Omit<ChannelMessage, "conversationId" | "messageId" | "createdAt"> & {
    conversationId?: string;
    messageId?: string;
    createdAt?: number;
  }): { message: ChannelMessage; created: boolean } {
    if (input.messageId) {
      const existing = this.getMessage(input.messageId);
      if (existing) return { message: existing, created: false };
    }

    const message: ChannelMessage = {
      ...input,
      conversationId: input.conversationId ?? randomUUID(),
      messageId: input.messageId ?? randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
      attemptCount: input.attemptCount ?? 1,
    };

    this.db.prepare(`
      INSERT INTO channel_messages (message_id, conversation_id, created_at, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(
      message.messageId,
      message.conversationId,
      message.createdAt,
      JSON.stringify(message),
    );

    return { message, created: true };
  }

  addAck(ack: ChannelAck): ChannelAck {
    const ackId = randomUUID();
    this.db.prepare(`
      INSERT INTO channel_acks (ack_id, conversation_id, message_id, timestamp, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      ackId,
      ack.conversationId,
      ack.messageId,
      ack.timestamp,
      JSON.stringify(ack),
    );
    return ack;
  }

  getConversation(conversationId: string): ChannelConversationSnapshot | undefined {
    if (this.isConversationSuppressed(conversationId)) return undefined;
    const messages = this.loadMessages(conversationId);
    if (messages.length === 0) return undefined;

    return {
      conversationId,
      messages,
      acknowledgements: this.loadAcks(conversationId),
    };
  }

  listConversations(filter?: { pendingOnly?: boolean }): ChannelConversationListEntry[] {
    const rows = this.db.prepare(`
      SELECT conversation_id
      FROM channel_messages
      ORDER BY created_at DESC
    `).all() as Array<{ conversation_id: string }>;

    const seen = new Set<string>();
    const entries: ChannelConversationListEntry[] = [];

    for (const row of rows) {
      if (seen.has(row.conversation_id)) continue;
      seen.add(row.conversation_id);
      if (this.isConversationSuppressed(row.conversation_id)) continue;

      const messages = this.loadMessages(row.conversation_id);
      if (messages.length === 0) continue;
      const acknowledgements = this.loadAcks(row.conversation_id);
      const entry = this.summarizeConversation(row.conversation_id, messages, acknowledgements);

      if (filter?.pendingOnly && !entry.pendingReply) continue;

      entries.push(entry);
    }

    return entries;
  }

  /** Delete every conversation whose most recent message is older than `cutoff`
   *  (a timestamp in ms). Removes the corresponding rows from `channel_messages`,
   *  `channel_acks`, and `channel_suppressed_conversations`. Returns the number
   *  of conversations deleted, for logging.
   *
   *  Used by the registry's hourly maintenance sweep to bound SQLite growth on
   *  long-running registries. Conversations actively used keep their `created_at`
   *  refreshed via every new inbound message, so the cutoff effectively measures
   *  "time since last activity". */
  deleteConversationsOlderThan(cutoff: number): number {
    const stale = this.db.prepare(`
      SELECT conversation_id, MAX(created_at) AS last_activity
      FROM channel_messages
      GROUP BY conversation_id
      HAVING last_activity < ?
    `).all(cutoff) as Array<{ conversation_id: string }>;

    if (stale.length === 0) return 0;

    const deleteMessages = this.db.prepare(`DELETE FROM channel_messages WHERE conversation_id = ?`);
    const deleteAcks = this.db.prepare(`DELETE FROM channel_acks WHERE conversation_id = ?`);
    const deleteSuppressed = this.db.prepare(`DELETE FROM channel_suppressed_conversations WHERE conversation_id = ?`);

    for (const row of stale) {
      deleteMessages.run(row.conversation_id);
      deleteAcks.run(row.conversation_id);
      deleteSuppressed.run(row.conversation_id);
    }
    return stale.length;
  }

  /** Find messages that are awaiting a reply but whose `expiresAt` deadline has
   *  passed without ever receiving a terminal ack (`answered` or `failed`). Used
   *  by the registry's ack sweeper to mark stuck conversations as failed and
   *  notify subscribers, instead of letting them sit in `pending` forever. */
  findExpiredAwaitingReply(now: number): ChannelMessage[] {
    const expired: ChannelMessage[] = [];
    const entries = this.listConversations();
    for (const entry of entries) {
      if (!entry.expired) continue;
      const messages = this.loadMessages(entry.conversationId);
      const acks = this.loadAcks(entry.conversationId);
      const latestAckByMessage = new Map<string, ChannelAck>();
      for (const ack of acks) latestAckByMessage.set(ack.messageId, ack);
      for (const msg of messages) {
        if (!msg.expectsResponse) continue;
        if (typeof msg.expiresAt !== "number" || msg.expiresAt > now) continue;
        const lastAck = latestAckByMessage.get(msg.messageId);
        if (lastAck?.state === "answered" || lastAck?.state === "failed") continue;
        expired.push(msg);
      }
    }
    return expired;
  }

  retryMessage(conversationId: string, messageId: string): ChannelMessage | undefined {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM channel_messages
      WHERE conversation_id = ? AND message_id = ?
    `).get(conversationId, messageId) as { payload_json: string } | undefined;

    if (!row) return undefined;

    const current = JSON.parse(row.payload_json) as ChannelMessage;
    const retried: ChannelMessage = {
      ...current,
      attemptCount: (current.attemptCount ?? 1) + 1,
      createdAt: Date.now(),
    };

    this.db.prepare(`
      UPDATE channel_messages
      SET created_at = ?, payload_json = ?
      WHERE message_id = ?
    `).run(retried.createdAt, JSON.stringify(retried), messageId);

    return retried;
  }

  suppressConversation(conversationId: string): boolean {
    const exists = this.db.prepare(`
      SELECT 1
      FROM channel_messages
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId);
    if (!exists) return false;

    this.db.prepare(`
      INSERT OR REPLACE INTO channel_suppressed_conversations (conversation_id, suppressed_at)
      VALUES (?, ?)
    `).run(conversationId, Date.now());
    return true;
  }

  reviveConversation(conversationId: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM channel_suppressed_conversations
      WHERE conversation_id = ?
    `).run(conversationId);
    return Number(result.changes ?? 0) > 0;
  }

  isConversationSuppressed(conversationId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1
      FROM channel_suppressed_conversations
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId);
    return Boolean(row);
  }

  private loadMessages(conversationId: string): ChannelMessage[] {
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM channel_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `).all(conversationId) as Array<{ payload_json: string }>;

    return rows.map((row) => JSON.parse(row.payload_json) as ChannelMessage);
  }

  private loadAcks(conversationId: string): ChannelAck[] {
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM channel_acks
      WHERE conversation_id = ?
      ORDER BY timestamp ASC
    `).all(conversationId) as Array<{ payload_json: string }>;

    return rows.map((row) => JSON.parse(row.payload_json) as ChannelAck);
  }

  private summarizeConversation(
    conversationId: string,
    messages: ChannelMessage[],
    acknowledgements: ChannelAck[],
  ): ChannelConversationListEntry {
    const now = Date.now();
    const lastMessage = messages[messages.length - 1]!;
    const latestAckByMessage = new Map<string, ChannelAck>();

    for (const ack of acknowledgements) {
      latestAckByMessage.set(ack.messageId, ack);
    }

    const pendingMessages = messages.filter((message) => {
      if (!message.expectsResponse) return false;
      const lastAck = latestAckByMessage.get(message.messageId);
      return lastAck?.state !== "answered" && lastAck?.state !== "failed";
    });

    const expired = pendingMessages.some(
      (message) => typeof message.expiresAt === "number" && message.expiresAt <= now,
    );
    const pendingReply = pendingMessages.length > 0 && !expired;
    const lastAckState = acknowledgements.length > 0
      ? acknowledgements[acknowledgements.length - 1]!.state
      : undefined;

    let status: ChannelConversationListEntry["status"] = "active";
    if (expired) status = "expired";
    else if (pendingMessages.length > 0) status = "pending";
    else if (lastAckState === "failed") status = "failed";
    else if (lastAckState === "answered") status = "answered";

    return {
      conversationId,
      lastMessage,
      pendingReply,
      expired,
      lastAckState,
      pendingCount: pendingMessages.length,
      pendingMessageIds: pendingMessages.map((message) => message.messageId),
      status,
    };
  }
}
