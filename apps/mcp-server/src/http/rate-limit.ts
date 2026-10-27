import type { NextFunction, Request, Response } from "express";

/**
 * In-memory token bucket (per process). Adequate for P0's single app replica; a multi-replica deployment
 * needs a shared store (documented in the deployment notes), because each replica keeps its own buckets.
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
  take(key: string): TakeResult;
}

/** Buckets kept before idle (full) ones are pruned. */
const PRUNE_THRESHOLD = 10_000;

export function createTokenBucketLimiter(
  options: TokenBucketOptions,
  now: () => number = Date.now,
): TokenBucketLimiter {
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

/** Express middleware answering 429 with Retry-After when the caller's bucket is empty. */
export function rateLimit(
  limiter: TokenBucketLimiter,
  scope: string,
  keyOf: (req: Request) => string = (req) => req.ip ?? req.socket.remoteAddress ?? "unknown",
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = limiter.take(`${scope}:${keyOf(req)}`);
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
