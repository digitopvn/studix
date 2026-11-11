import { StudixError } from "@studix/shared";

/**
 * Bounds how many calls run at once against one vendor account. Shared by every provider instance in the
 * process (workspace overrides build their own MultixProvider), so parallel jobs in one worker cannot exceed
 * the vendor's concurrent-request limit together.
 */
export class VendorCallLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();

  /** Run `fn` once fewer than `limit` calls hold `key`. A signal that aborts while waiting gives up the turn. */
  async run<T>(key: string, limit: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(key, Math.max(1, Math.floor(limit)), signal);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  /** Calls holding `key` right now. */
  inFlight(key: string): number {
    return this.active.get(key) ?? 0;
  }

  private acquire(key: string, limit: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.inFlight(key) < limit) {
      this.active.set(key, this.inFlight(key) + 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const queue = this.waiting.get(key) ?? [];
      this.waiting.set(key, queue);
      const onAbort = () => {
        const at = queue.indexOf(grant);
        if (at >= 0) queue.splice(at, 1);
        reject(cancelled());
      };
      // The releasing call hands its slot straight to the next waiter, so the count never drops in between.
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      queue.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(key: string): void {
    const next = this.waiting.get(key)?.shift();
    if (next) {
      next();
      return;
    }
    const left = this.inFlight(key) - 1;
    if (left > 0) this.active.set(key, left);
    else {
      this.active.delete(key);
      this.waiting.delete(key);
    }
  }
}

function cancelled(): StudixError {
  return new StudixError("CANCELLED", "The request was cancelled while waiting for a provider slot");
}

/** The limiter every MultixProvider in this process shares unless a test passes its own. */
export const sharedVendorCallLimiter = new VendorCallLimiter();
