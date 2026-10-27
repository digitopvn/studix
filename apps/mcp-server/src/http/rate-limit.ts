import type { RateLimitRepository } from "@studix/database";
import type { Logger } from "@studix/shared";
import type { NextFunction, Request, Response } from "express";

/**
 * Token buckets. `createTokenBucketLimiter` keeps them in process memory (single replica, tests); behind more
 * than one replica use `createSharedLimiter`, whose buckets live in Postgres so every replica draws on the same
 * balance and a restart does not reset it.
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

/** How long the shared store may take before the request is let through. */
const STORE_TIMEOUT_MS = 150;
const WARN_EVERY_MS = 30_000;

/**
 * Limiter over the shared Postgres store, fronted by a per-process bucket of the same size so floods are
 * refused without touching the database. A store error or a slow answer lets the request through (logged,
 * at most every 30s): the limiter is abuse protection and must not take the app down with the database.
 */
export function createSharedLimiter(
  store: RateLimitRepository,
  options: TokenBucketOptions,
  logger: Pick<Logger, "warn">,
): TokenBucketLimiter {
  const local = createTokenBucketLimiter(options);
  let lastWarn = 0;
  const failOpen = (reason: string): TakeResult => {
    const at = Date.now();
    if (at - lastWarn >= WARN_EVERY_MS) {
      lastWarn = at;
      logger.warn("rate limit store unavailable, allowing request", { error: reason });
    }
    return { allowed: true, retryAfterSeconds: 0 };
  };
  return {
    async take(key) {
      const first = local.take(key);
      if (!first.allowed) return first;
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("store timed out")), STORE_TIMEOUT_MS);
        });
        return await Promise.race([store.take(key, options), timeout]);
      } catch (err) {
        return failOpen(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Delete idle shared buckets now and then; call `stop()` on shutdown. */
export function startRateLimitPruner(
  store: RateLimitRepository,
  logger: Pick<Logger, "warn">,
  everyMs = 10 * 60_000,
): { stop(): void } {
  const timer = setInterval(() => {
    store.prune().catch((err) => {
      logger.warn("rate limit prune failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** Express middleware answering 429 with Retry-After when the caller's bucket is empty. */
export function rateLimit(
  limiter: TokenBucketLimiter,
  scope: string,
  keyOf: (req: Request) => string = (req) => req.ip ?? req.socket.remoteAddress ?? "unknown",
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await limiter.take(`${scope}:${keyOf(req)}`);
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
  /** MCP traffic per client IP before the key is verified; looser because clients share egress IPs. */
  mcpIp: { capacity: 600, refillPerSecond: 20 },
  /** MCP traffic per workspace: polling clients make many small calls. */
  mcp: { capacity: 120, refillPerSecond: 4 },
  /** Dashboard JSON API. */
  api: { capacity: 240, refillPerSecond: 8 },
} satisfies Record<string, TokenBucketOptions>;
