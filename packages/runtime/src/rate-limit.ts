/**
 * In-process token buckets for outgoing messages. There is exactly one sender at a
 * time (it holds the `outbox-sender` job lease), so in-memory limits are sufficient —
 * no Redis needed.
 */

export interface RateLimits {
  /** Messages per second across all chats (Telegram: about 30). */
  globalPerSecond: number;
  /** Messages per minute into one group (Telegram: 20). */
  groupPerMinute: number;
  /** Messages per second into one private chat (Telegram: about 1). */
  privatePerSecond: number;
}

export const TELEGRAM_RATE_LIMITS: RateLimits = {
  globalPerSecond: 25,
  groupPerMinute: 20,
  privatePerSecond: 1,
};

class Bucket {
  private tokens: number;
  private updatedAt: number;
  private readonly capacity: number;
  private readonly perMs: number;

  constructor(capacity: number, perMs: number, now: number) {
    this.capacity = capacity;
    this.perMs = perMs;
    this.tokens = capacity;
    this.updatedAt = now;
  }

  private refill(now: number) {
    // A clock that jumps backwards (NTP correction, test clocks) must not drain the
    // bucket: elapsed time is never negative, the reference point just moves.
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.perMs);
    this.updatedAt = now;
  }

  /** ms until a token is available (0 = available now). */
  waitMs(now: number): number {
    this.refill(now);
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.perMs);
  }

  take(now: number) {
    this.refill(now);
    this.tokens -= 1;
  }
}

export class SendRateLimiter {
  private readonly global: Bucket;
  private readonly chats = new Map<string, Bucket>();
  private readonly limits: RateLimits;
  private readonly isGroupChat: (chatId: string) => boolean;

  constructor(limits: RateLimits, isGroupChat: (chatId: string) => boolean, now = Date.now()) {
    this.limits = limits;
    this.isGroupChat = isGroupChat;
    this.global = new Bucket(limits.globalPerSecond, limits.globalPerSecond / 1000, now);
  }

  private chat(chatId: string, now: number): Bucket {
    let bucket = this.chats.get(chatId);
    if (!bucket) {
      bucket = this.isGroupChat(chatId)
        ? new Bucket(5, this.limits.groupPerMinute / 60_000, now)
        : new Bucket(1, this.limits.privatePerSecond / 1000, now);
      this.chats.set(chatId, bucket);
    }
    return bucket;
  }

  /**
   * Reserves a slot for one message to `chatId` (or only a global slot when `chatId`
   * is null, e.g. answering a button). Returns 0 when reserved, else ms to wait.
   */
  tryReserve(chatId: string | null, now = Date.now()): number {
    const wait = Math.max(this.global.waitMs(now), chatId ? this.chat(chatId, now).waitMs(now) : 0);
    if (wait > 0) return wait;
    this.global.take(now);
    if (chatId) this.chat(chatId, now).take(now);
    return 0;
  }
}
