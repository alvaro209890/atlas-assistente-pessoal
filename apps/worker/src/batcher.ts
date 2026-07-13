import {
  BATCH_MAX_WINDOW_MS,
  BATCH_QUIET_WINDOW_MS,
  type NormalizedMessage,
} from "@atlas/shared";

export interface MessageBatch {
  userId: string;
  chatJid: string;
  messages: NormalizedMessage[];
  startedAt: Date;
  flushedAt: Date;
}

interface PendingBatch {
  userId: string;
  chatJid: string;
  messages: Map<string, NormalizedMessage>;
  startedAt: Date;
  quietTimer: NodeJS.Timeout;
  maxTimer: NodeJS.Timeout;
  flushing: boolean;
  flushPromise: Promise<void> | undefined;
}

export interface ConversationBatcherOptions {
  onFlush: (batch: MessageBatch) => void | Promise<void>;
  quietWindowMs?: number;
  maxWindowMs?: number;
  maxMessages?: number;
  now?: () => Date;
}

export class ConversationBatcher {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly quietWindowMs: number;
  private readonly maxWindowMs: number;
  private readonly maxMessages: number;
  private readonly now: () => Date;

  constructor(private readonly options: ConversationBatcherOptions) {
    this.quietWindowMs = options.quietWindowMs ?? BATCH_QUIET_WINDOW_MS;
    this.maxWindowMs = options.maxWindowMs ?? BATCH_MAX_WINDOW_MS;
    this.maxMessages = options.maxMessages ?? 15;
    this.now = options.now ?? (() => new Date());
  }

  private triggerFlush(key: string): void {
    void this.flush(key).catch(() => {
      // The batch remains pending and receives fresh timers inside flush().
      // Persistence outages must not become unhandled rejections or drop messages.
    });
  }

  private armTimers(key: string, batch: PendingBatch): void {
    clearTimeout(batch.quietTimer);
    clearTimeout(batch.maxTimer);
    batch.quietTimer = setTimeout(() => this.triggerFlush(key), this.quietWindowMs);
    batch.maxTimer = setTimeout(() => this.triggerFlush(key), this.maxWindowMs);
  }

  add(message: NormalizedMessage): void {
    const key = `${message.userId}\u001f${message.chatJid}`;
    const existing = this.pending.get(key);
    if (existing) {
      existing.messages.set(message.id, message);
      if (existing.flushing) return;
      if (existing.messages.size >= this.maxMessages) {
        this.triggerFlush(key);
        return;
      }
      clearTimeout(existing.quietTimer);
      existing.quietTimer = setTimeout(() => this.triggerFlush(key), this.quietWindowMs);
      return;
    }

    const batch: PendingBatch = {
      userId: message.userId,
      chatJid: message.chatJid,
      messages: new Map([[message.id, message]]),
      startedAt: this.now(),
      quietTimer: setTimeout(() => this.triggerFlush(key), this.quietWindowMs),
      maxTimer: setTimeout(() => this.triggerFlush(key), this.maxWindowMs),
      flushing: false,
      flushPromise: undefined,
    };
    this.pending.set(key, batch);
    if (batch.messages.size >= this.maxMessages) this.triggerFlush(key);
  }

  async flush(key: string): Promise<void> {
    const batch = this.pending.get(key);
    if (!batch) return;
    if (batch.flushing) return batch.flushPromise;
    batch.flushing = true;
    clearTimeout(batch.quietTimer);
    clearTimeout(batch.maxTimer);
    const messages = [...batch.messages.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    const promise = (async () => {
      let flushed = false;
      try {
        await this.options.onFlush({
          userId: batch.userId,
          chatJid: batch.chatJid,
          messages,
          startedAt: batch.startedAt,
          flushedAt: this.now(),
        });
        flushed = true;
        for (const message of messages) batch.messages.delete(message.id);
        if (batch.messages.size === 0) {
          if (this.pending.get(key) === batch) this.pending.delete(key);
          return;
        }
        batch.startedAt = this.now();
      } catch (error) {
        throw error;
      } finally {
        batch.flushing = false;
        batch.flushPromise = undefined;
        if (this.pending.get(key) === batch && batch.messages.size > 0) {
          this.armTimers(key, batch);
          if (flushed && batch.messages.size >= this.maxMessages) this.triggerFlush(key);
        }
      }
    })();
    batch.flushPromise = promise;
    return promise;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((key) => this.flush(key)));
  }
}
