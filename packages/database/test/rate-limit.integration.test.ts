import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const slow = { capacity: 3, refillPerSecond: 0.001 };

describe("rate limit repository", () => {
  it("grants the burst, refuses once empty and keeps keys independent", async () => {
    const { rateLimits } = db.current.repos;
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await rateLimits.take("burst:a", slow)).allowed);
    expect(results).toEqual([true, true, true, false]);
    expect((await rateLimits.take("burst:b", slow)).allowed).toBe(true);
  });

  it("refills from the time elapsed since the last update", async () => {
    const { rateLimits } = db.current.repos;
    const fast = { capacity: 2, refillPerSecond: 1 };
    await rateLimits.take("refill", fast);
    await rateLimits.take("refill", fast);
    expect((await rateLimits.take("refill", fast)).allowed).toBe(false);
    await db.current
      .client`update rate_limit_buckets set updated_at = now() - interval '5 seconds' where key = 'refill'`;
    const after = await rateLimits.take("refill", fast);
    expect(after.allowed).toBe(true);
    expect(after.tokens).toBeCloseTo(1, 0);
  });

  it("never double-spends under concurrent takes from several clients", async () => {
    const { rateLimits } = db.current.repos;
    const outcomes = await Promise.all(
      Array.from({ length: 30 }, () => rateLimits.take("race", { capacity: 5, refillPerSecond: 0.001 })),
    );
    expect(outcomes.filter((o) => o.allowed)).toHaveLength(5);
  });

  it("prunes only buckets idle for longer than the window", async () => {
    const { rateLimits } = db.current.repos;
    await rateLimits.take("idle", slow);
    await rateLimits.take("fresh", slow);
    await db.current
      .client`update rate_limit_buckets set updated_at = now() - interval '2 hours' where key = 'idle'`;
    expect(await rateLimits.prune(3600)).toBe(1);
    const keys = await db.current.client`select key from rate_limit_buckets where key in ('idle','fresh')`;
    expect(keys.map((r) => r.key)).toEqual(["fresh"]);
  });
});
