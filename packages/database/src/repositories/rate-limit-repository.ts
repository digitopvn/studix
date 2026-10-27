import { sql } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { rateLimitBuckets } from "../schema/rate-limits.ts";

export interface BucketOptions {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export interface BucketTake {
  allowed: boolean;
  /** Tokens left after the take (fractional; below 1 when refused). */
  tokens: number;
}

export interface RateLimitRepository {
  /**
   * Refill the bucket for the time since its last update and take one token, atomically in one statement,
   * so concurrent replicas never double-spend. Time comes from the database clock, not the caller's.
   */
  take(key: string, options: BucketOptions): Promise<BucketTake>;
  /** Delete buckets untouched for `idleSeconds` (long enough to be full again); returns rows removed. */
  prune(idleSeconds: number): Promise<number>;
}

export function createRateLimitRepository(db: StudixDb): RateLimitRepository {
  return {
    async take(key, { capacity, refillPerSecond }) {
      const cap = sql`${capacity}::float8`;
      const refilled = sql`least(${cap}, ${rateLimitBuckets.tokens} + extract(epoch from (now() - ${rateLimitBuckets.updatedAt})) * ${refillPerSecond}::float8)`;
      const rows = await db.execute<{ tokens: number; granted: boolean }>(sql`
        insert into ${rateLimitBuckets} (key, tokens, granted, updated_at)
        values (${key}, ${cap} - 1, true, now())
        on conflict (key) do update set
          tokens = case when ${refilled} >= 1 then ${refilled} - 1 else ${refilled} end,
          granted = ${refilled} >= 1,
          updated_at = now()
        returning tokens, granted`);
      const row = rows[0];
      if (!row) throw new Error("rate limit upsert returned no row");
      return { allowed: row.granted, tokens: Number(row.tokens) };
    },
    async prune(idleSeconds) {
      const rows = await db.execute(sql`
        delete from ${rateLimitBuckets}
        where updated_at < now() - ${idleSeconds}::float8 * interval '1 second'
        returning key`);
      return rows.length;
    },
  };
}
