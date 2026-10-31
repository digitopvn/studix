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
/** A store slower than this is treated as unavailable for the call, so requests are never held on it. */
const STORE_TIMEOUT_MS = 250;
const WARN_EVERY_MS = 30_000;

/** One pruner per store and process, however many limiters share it. */
const lastPrune = new WeakMap<RateLimitRepository, { at: number; running: boolean }>();

function maybePrune(store: RateLimitRepository, logger: Logger, at: number) {
  const state = lastPrune.get(store) ?? { at, running: false };
  lastPrune.set(store, state);
  if (state.running || at - state.at < SHARED_PRUNE_EVERY_MS) return;
  state.running = true;
  state.at = at;
  store
    .prune(SHARED_PRUNE_IDLE_SECONDS)
    .catch((err: unknown) => logger.warn("rate limit prune failed", { error: errorMessage(err) }))
    .finally(() => {
      state.running = false;
    });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`rate limit store timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Token bucket in the shared store. Refused keys are remembered locally until a token can exist again, so a
 * flood of refused requests never turns into database writes. If the store fails or is slow, the call is
 * decided by a per-process bucket instead (degraded: limits multiply by replica count, nothing hangs).
 */
export function createSharedLimiter(
  store: RateLimitRepository,
  options: TokenBucketOptions,
  logger: Logger,
  now: () => number = Date.now,
): TokenBucketLimiter {
  const fallback = createTokenBucketLimiter(options, now);
  const deniedUntil = new Map<string, number>();
  let lastWarn = Number.NEGATIVE_INFINITY;

  return {
    async take(key) {
      const at = now();
      const blockedUntil = deniedUntil.get(key);
      if (blockedUntil !== undefined) {
        if (blockedUntil > at)
          return { allowed: false, retryAfterSeconds: Math.ceil((blockedUntil - at) / 1000) };
        deniedUntil.delete(key);
      }
      try {
        const { allowed, tokens } = await withTimeout(store.take(key, options), STORE_TIMEOUT_MS);
        maybePrune(store, logger, at);
        if (allowed) return { allowed, retryAfterSeconds: 0 };
        const retryAfterSeconds = Math.ceil((1 - tokens) / options.refillPerSecond);
        if (deniedUntil.size >= PRUNE_THRESHOLD) {
          for (const [k, until] of deniedUntil) if (until <= at) deniedUntil.delete(k);
        }
        deniedUntil.set(key, at + retryAfterSeconds * 1000);
        return { allowed, retryAfterSeconds };
      } catch (err) {
        if (at - lastWarn >= WARN_EVERY_MS) {
          lastWarn = at;
          logger.warn("shared rate limit unavailable, using the per-process bucket", {
            error: errorMessage(err),
          });
        }
        return fallback.take(key);
      }
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bucket subject for a client address. IPv6 clients usually control a whole /64, so they share one bucket
 * per /64 instead of minting a fresh bucket per address.
 */
export function clientKey(ip: string): string {
  const addr = ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
  if (!addr.includes(":")) return addr;
  const groups = addr.split("::")[0]?.split(":") ?? [];
  if (!addr.includes("::") && groups.length === 8) return `${groups.slice(0, 4).join(":")}::/64`;
  return `${(addr.split("::")[0] ?? "").split(":").slice(0, 4).join(":")}::/64`;
}

/** Express middleware answering 429 with Retry-After when the caller's bucket is empty. */
export function rateLimit(
  limiter: TokenBucketLimiter,
  scope: string,
  keyOf: (req: Request) => string = (req) => clientKey(req.ip ?? req.socket.remoteAddress ?? "unknown"),
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
  /**
   * Pre-authentication flood guard per client IP on /mcp. Generous because hosted AI clients share egress
   * IPs across tenants; the per-workspace `mcp` limit is the real quota.
   */
  mcpIp: { capacity: 1200, refillPerSecond: 40 },
  /** MCP traffic per workspace: polling clients make many small calls. */
  mcp: { capacity: 120, refillPerSecond: 4 },
  /** Dashboard JSON API. */
  api: { capacity: 240, refillPerSecond: 8 },
} satisfies Record<string, TokenBucketOptions>;
