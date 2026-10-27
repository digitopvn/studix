import { describe, expect, it } from "vitest";
import { createRateLimitRepository } from "../src/repositories/rate-limit-repository.ts";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const spec = { capacity: 3, refillPerSecond: 1 };

describe("Postgres rate limit buckets", () => {
  it("allows a burst then refuses with a retry hint, per key", async () => {
    const { rateLimits } = db.current.repos;
    expect((await rateLimits.take("burst:a", spec)).allowed).toBe(true);
    expect((await rateLimits.take("burst:a", spec)).allowed).toBe(true);
    expect((await rateLimits.take("burst:a", spec)).allowed).toBe(true);
    const refused = await rateLimits.take("burst:a", spec);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect((await rateLimits.take("burst:b", spec)).allowed).toBe(true);
  });

  it("refills with elapsed database time", async () => {
    const { rateLimits } = db.current.repos;
    const fast = { capacity: 1, refillPerSecond: 20 };
    expect((await rateLimits.take("refill:a", fast)).allowed).toBe(true);
    expect((await rateLimits.take("refill:a", fast)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await rateLimits.take("refill:a", fast)).allowed).toBe(true);
  });

  it("is atomic: concurrent takers across separate repository handles never exceed the burst", async () => {
    const replicas = [
      createRateLimitRepository(db.current.db),
      createRateLimitRepository(db.current.db),
      createRateLimitRepository(db.current.db),
    ];
    const slow = { capacity: 5, refillPerSecond: 0.001 };
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => replicas[i % replicas.length]?.take("atomic:a", slow)),
    );
    expect(results.filter((r) => r?.allowed)).toHaveLength(5);
  });

  it("rejects nonsensical specs", async () => {
    const { rateLimits } = db.current.repos;
    await expect(rateLimits.take("bad", { capacity: 0, refillPerSecond: 1 })).rejects.toThrow(RangeError);
  });

  it("prunes only idle buckets", async () => {
    const { rateLimits } = db.current.repos;
    await rateLimits.take("prune:fresh", spec);
    await db.current.client`insert into rate_limit_buckets (key, tokens, allowed, updated_at)
      values ('prune:stale', 3, true, now() - interval '2 hours')`;
    expect(await rateLimits.prune()).toBe(1);
    const keys = await db.current.client`select key from rate_limit_buckets where key like 'prune:%'`;
    expect(keys.map((r) => r.key)).toEqual(["prune:fresh"]);
  });
});
