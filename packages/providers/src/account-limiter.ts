import { StudixError } from "@studix/shared";

interface Slot {
  active: number;
  waiting: Array<{ limit: number; start: () => void }>;
}

/**
 * At most `limit` concurrent calls per key in this process, served first come first served. A vendor
 * account caps concurrent requests (ElevenLabs answers 429 `concurrent_limit_exceeded` past its plan's
 * limit), and jobs, stages and workspace provider instances of one worker all share that account, so one
 * limiter serves the whole process.
 */
export class KeyedLimiter {
  private readonly slots = new Map<string, Slot>();

  async run<T>(key: string, limit: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(key, Math.max(1, Math.floor(limit)), signal);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  /** Calls running and waiting under a key; for tests and diagnostics. */
  load(key: string): { active: number; waiting: number } {
    const slot = this.slots.get(key);
    return { active: slot?.active ?? 0, waiting: slot?.waiting.length ?? 0 };
  }

  private acquire(key: string, limit: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { active: 0, waiting: [] };
      this.slots.set(key, slot);
    }
    if (slot.active < limit && slot.waiting.length === 0) {
      slot.active += 1;
      return Promise.resolve();
    }
    const queue = slot;
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        limit,
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const at = queue.waiting.indexOf(waiter);
        if (at >= 0) queue.waiting.splice(at, 1);
        this.drain(key);
        reject(cancelled());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.waiting.push(waiter);
    });
  }

  private release(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.active -= 1;
    this.drain(key);
  }

  private drain(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    while (slot.waiting.length > 0 && slot.active < slot.waiting[0]!.limit) {
      slot.active += 1;
      slot.waiting.shift()!.start();
    }
    if (slot.active === 0 && slot.waiting.length === 0) this.slots.delete(key);
  }
}

const cancelled = () => new StudixError("CANCELLED", "The request was cancelled while waiting for its turn");

/** The limiter every Multix provider instance of this process shares. */
export const processAccountLimiter = new KeyedLimiter();
