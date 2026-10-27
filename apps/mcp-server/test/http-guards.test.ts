import { describe, expect, it } from "vitest";
import { dashboardCsp } from "../src/http/dashboard-static.ts";
import { createTokenBucketLimiter } from "../src/http/rate-limit.ts";
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
