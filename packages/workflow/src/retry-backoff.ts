export interface RetryBackoffOptions {
  /** Delay before the first retry. */
  baseMs: number;
  /** Upper bound for any delay. */
  maxMs: number;
}

export const DEFAULT_RETRY_BACKOFF: RetryBackoffOptions = { baseMs: 5_000, maxMs: 300_000 };

/** Exponential backoff: base * 2^(attempt-1), capped. `attempt` is the attempt that just failed (1-based). */
export function retryDelayMs(attempt: number, options: RetryBackoffOptions = DEFAULT_RETRY_BACKOFF): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(options.maxMs, options.baseMs * 2 ** (n - 1));
}
