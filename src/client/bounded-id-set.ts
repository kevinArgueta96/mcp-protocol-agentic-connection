/**
 * Insertion-ordered set with a hard cap. When the cap is reached, the oldest
 * inserted id is evicted to make room. Used for in-process dedup buckets like
 * surfacedInboxMessageIds (MCP adapter) and injectedMessageIds (bridges) that
 * would otherwise grow unbounded across the lifetime of a long-running daemon.
 *
 * Note: this is best-effort dedup within one process. The authoritative source
 * of "did this messageId already get handled" is the registry's persisted ack
 * ledger. When a process restarts, sync* methods rebuild the set from that
 * ledger, so eviction here cannot cause duplicate delivery — only a duplicate
 * dedup attempt against an already-handled message, which is harmless.
 */
export class BoundedIdSet {
  private readonly ids = new Set<string>();
  private readonly maxSize: number;

  constructor(maxSize = 5_000) {
    this.maxSize = maxSize;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    if (this.ids.size >= this.maxSize) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(id);
  }

  delete(id: string): boolean {
    return this.ids.delete(id);
  }

  clear(): void {
    this.ids.clear();
  }

  get size(): number {
    return this.ids.size;
  }
}
