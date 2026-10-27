import type { RateLimitRepository } from "@studix/database";
import { createLogger } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { dashboardCsp } from "../src/http/dashboard-static.ts";
import { clientKey, createSharedLimiter, createTokenBucketLimiter } from "../src/http/rate-limit.ts";
import { hostnameOf, originOf, uniqueHostnames } from "../src/http/request-guards.ts";

describe("token bucket limiter", () => {
  it("allows a burst, then refuses with a retry hint until tokens refill", () => {
    let now = 0;
    const limiter = createTokenBucketLimiter({ capacity: 2, refillPerSecond: 1 }, () => now);
    expect(limiter.take("ip").allowed).toBe(true);
    expect(limiter.take("ip").allowed).toBe(true);
    const refused = limiter.take("ip");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limiter.take("other-ip").allowed).toBe(true);
    now += 1000;
    expect(limiter.take("ip").allowed).toBe(true);
  });

  it("rejects nonsensical options", () => {
    expect(() => createTokenBucketLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => createTokenBucketLimiter({ capacity: 1, refillPerSecond: 0 })).toThrow(RangeError);
  });
});

describe("shared limiter", () => {
  const logger = createLogger({}, { level: "error" });
  const options = { capacity: 1, refillPerSecond: 0.5 };

  it("derives the retry hint from the store's remaining tokens", async () => {
    const store: RateLimitRepository = {
      take: async () => ({ allowed: false, tokens: 0.25 }),
      prune: async () => 0,
    };
    const result = await createSharedLimiter(store, options, logger).take("k");
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 2 });
  });

  it("falls back to a per-process bucket when the store fails", async () => {
    const store: RateLimitRepository = {
      take: async () => {
        throw new Error("connection refused");
      },
      prune: async () => 0,
    };
    const limiter = createSharedLimiter(store, options, logger);
    expect((await limiter.take("k")).allowed).toBe(true);
    expect((await limiter.take("k")).allowed).toBe(false);
  });

  it("keeps refused keys away from the store until a token can exist again", async () => {
    let now = 0;
    let takes = 0;
    const store: RateLimitRepository = {
      take: async () => {
        takes++;
        return { allowed: false, tokens: 0 };
      },
      prune: async () => 0,
    };
    const limiter = createSharedLimiter(store, options, logger, () => now);
    expect(await limiter.take("k")).toEqual({ allowed: false, retryAfterSeconds: 2 });
    now += 1000;
    expect(await limiter.take("k")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(takes).toBe(1);
    now += 1000;
    await limiter.take("k");
    expect(takes).toBe(2);
  });

  it("does not hold a request on a slow store", async () => {
    const store: RateLimitRepository = {
      take: () => new Promise(() => {}),
      prune: async () => 0,
    };
    const limiter = createSharedLimiter(store, options, logger);
    expect((await limiter.take("k")).allowed).toBe(true);
  });

  it("prunes idle buckets at most once per interval", async () => {
    let now = 0;
    let pruned = 0;
    const store: RateLimitRepository = {
      take: async () => ({ allowed: true, tokens: 1 }),
      prune: async () => {
        pruned++;
        return 0;
      },
    };
    const limiter = createSharedLimiter(store, options, logger, () => now);
    await limiter.take("k");
    expect(pruned).toBe(0);
    now += 11 * 60_000;
    await limiter.take("k");
    await limiter.take("k");
    await new Promise((r) => setImmediate(r));
    expect(pruned).toBe(1);
  });
});

describe("clientKey", () => {
  it("leaves IPv4 alone, unwraps mapped addresses and groups IPv6 by /64", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2:ffff::1")).toBe("2001:db8:1:2::/64");
  });
});

describe("host and origin helpers", () => {
  it("strips ports from Host values, including IPv6", () => {
    expect(hostnameOf("studix.example.com:443")).toBe("studix.example.com");
    expect(hostnameOf("[::1]:8787")).toBe("[::1]");
    expect(uniqueHostnames(["a.test:1", "a.test:2", "b.test"])).toEqual(["a.test", "b.test"]);
  });

  it("derives origins from configured URLs", () => {
    expect(originOf("https://studix.example.com/app/")).toBe("https://studix.example.com");
  });
});

describe("dashboard CSP", () => {
  it("allows media only from self and the configured storage origins", () => {
    const csp = dashboardCsp(["https://s3.example.com"]);
    expect(csp).toContain("media-src 'self' blob: https://s3.example.com");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });
});
