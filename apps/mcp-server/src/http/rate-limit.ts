import type { RateLimitRepository } from "@studix/database";
import type { Logger } from "@studix/shared";
import type { NextFunction, Request, Response } from "express";

/**
 * Token buckets. `createSharedLimiter` keeps them in Postgres so every app replica draws from the same
 * bucket and restarts do not reset it; the in-memory limiter (per process) is the fallback used when no
 * store is wired or the store is unreachable.
 */
export interface TokenBucketOptions {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export interface TakeResult {
  allowed: boolean;
  /** Seconds until one token is available (0 when allowed). */
  retryAfterSeconds: number;
}

export interface TokenBucketLimiter {
  take(key: string): TakeResult | Promise<TakeResult>;
}

/** Buckets kept before idle (full) ones are pruned. */
const PRUNE_THRESHOLD = 10_000;

export function createTokenBucketLimiter(
  options: TokenBucketOptions,
  now: () => number = Date.now,
): { take(key: string): TakeResult } {
  if (!(options.capacity >= 1) || !(options.refillPerSecond > 0)) {
    throw new RangeError("token bucket needs capacity >= 1 and refillPerSecond > 0");
  }
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();

  const refill = (bucket: { tokens: number; updatedAt: number }, at: number) => {
    const elapsed = Math.max(0, at - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsed * options.refillPerSecond);
    bucket.updatedAt = at;
  };

  const prune = (at: number) => {
    for (const [key, bucket] of buckets) {
      refill(bucket, at);
      if (bucket.tokens >= options.capacity) buckets.delete(key);
    }
  };

  return {
    take(key) {
      const at = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= PRUNE_THRESHOLD) prune(at);
        bucket = { tokens: options.capacity, updatedAt: at };
        buckets.set(key, bucket);
      } else {
        refill(bucket, at);
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }
      return { allowed: false, retryAfterSeconds: Math.ceil((1 - bucket.tokens) / options.refillPerSecond) };
    },
  };
}

/** Buckets idle this long are full again under every default limit, so they can be dropped. */
const SHARED_PRUNE_IDLE_SECONDS = 3600;
const SHARED_PRUNE_EVERY_MS = 10 * 60_000;

/**
 * Token bucket in the shared store. If the store fails, the call is decided by a per-process bucket
 * instead (degraded: limits multiply by replica count, but the endpoint stays bounded and available).
 */
export function createSharedLimiter(
  store: RateLimitRepository,
  options: TokenBucketOptions,
  logger: Logger,
  now: () => number = Date.now,
): TokenBucketLimiter {
  const fallback = createTokenBucketLimiter(options, now);
  let lastPrune = now();
  let pruning = false;

  const maybePrune = () => {
    if (pruning || now() - lastPrune < SHARED_PRUNE_EVERY_MS) return;
    pruning = true;
    lastPrune = now();
    store
      .prune(SHARED_PRUNE_IDLE_SECONDS)
      .catch((err: unknown) => logger.warn("rate limit prune failed", { error: errorMessage(err) }))
      .finally(() => {
        pruning = false;
      });
  };

  return {
    async take(key) {
      try {
        const { allowed, tokens } = await store.take(key, options);
        maybePrune();
        return allowed
          ? { allowed, retryAfterSeconds: 0 }
          : { allowed, retryAfterSeconds: Math.ceil((1 - tokens) / options.refillPerSecond) };
      } catch (err) {
        logger.warn("shared rate limit unavailable, using the per-process bucket", {
          error: errorMessage(err),
        });
        return fallback.take(key);
      }
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Express middleware answering 429 with Retry-After when the caller's bucket is empty. */
export function rateLimit(
  limiter: TokenBucketLimiter,
  scope: string,
  keyOf: (req: Request) => string = (req) => req.ip ?? req.socket.remoteAddress ?? "unknown",
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let result: TakeResult;
    try {
      result = await limiter.take(`${scope}:${keyOf(req)}`);
    } catch (err) {
      next(err);
      return;
    }
    if (result.allowed) {
      next();
      return;
    }
    res
      .status(429)
      .set("Retry-After", String(result.retryAfterSeconds))
      .json({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests",
          retryable: true,
          suggestedAction: `Retry after ${result.retryAfterSeconds}s.`,
        },
      });
  };
}

export const DEFAULT_RATE_LIMITS = {
  /** Sign-in/sign-up: small burst, slow refill (credential stuffing). */
  auth: { capacity: 20, refillPerSecond: 0.2 },
  /** MCP traffic: polling clients make many small calls. */
  mcp: { capacity: 120, refillPerSecond: 4 },
  /** Dashboard JSON API. */
  api: { capacity: 240, refillPerSecond: 8 },
} satisfies Record<string, TokenBucketOptions>;
