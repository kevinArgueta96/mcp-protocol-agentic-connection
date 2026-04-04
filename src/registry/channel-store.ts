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
  return resolve(process.cwd(), ".agent-bridge", "registry.sqlite");
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
    `);
  }

  createMessage(input: Omit<ChannelMessage, "conversationId" | "messageId" | "createdAt"> & {
    conversationId?: string;
    messageId?: string;
    createdAt?: number;
  }): ChannelMessage {
    const message: ChannelMessage = {
      ...input,
      conversationId: input.conversationId ?? randomUUID(),
      messageId: input.messageId ?? randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
      attemptCount: input.attemptCount ?? 1,
    };

    this.db.prepare(`
      INSERT OR REPLACE INTO channel_messages (message_id, conversation_id, created_at, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(
      message.messageId,
      message.conversationId,
      message.createdAt,
      JSON.stringify(message),
    );

    return message;
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
      SELECT conversation_id, payload_json
      FROM channel_messages
      ORDER BY created_at DESC
    `).all() as Array<{ conversation_id: string; payload_json: string }>;

    const seen = new Set<string>();
    const now = Date.now();
    const entries: ChannelConversationListEntry[] = [];

    for (const row of rows) {
      if (seen.has(row.conversation_id)) continue;
      seen.add(row.conversation_id);

      const lastMessage = JSON.parse(row.payload_json) as ChannelMessage;
      const acknowledgements = this.loadAcks(row.conversation_id);
      const lastAckForMessage = [...acknowledgements].reverse().find((ack) => ack.messageId === lastMessage.messageId);
      const answered = acknowledgements.some((ack) => ack.messageId === lastMessage.messageId && ack.state === "answered");
      const expired = typeof lastMessage.expiresAt === "number" && lastMessage.expiresAt <= now;
      const pendingReply = lastMessage.expectsResponse === true && !answered && !expired;

      if (filter?.pendingOnly && !pendingReply) continue;

      entries.push({
        conversationId: row.conversation_id,
        lastMessage,
        pendingReply,
        expired,
        lastAckState: lastAckForMessage?.state,
      });
    }

    return entries;
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
}
