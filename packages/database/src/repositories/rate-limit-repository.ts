import { sql } from "drizzle-orm";
import type { StudixDb } from "../client.ts";

export interface BucketSpec {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export interface BucketDecision {
  allowed: boolean;
  /** Seconds until one token is available (0 when allowed). */
  retryAfterSeconds: number;
}

/** A bucket untouched this long is full again for every configured limit, so its row can go. */
const IDLE_ROW_TTL = "1 hour";

export interface RateLimitRepository {
  /** Take one token from `key`'s bucket in a single atomic statement; the database clock decides refill. */
  take(key: string, spec: BucketSpec): Promise<BucketDecision>;
  /** Delete idle buckets; returns how many rows went. */
  prune(): Promise<number>;
}

export function createRateLimitRepository(db: StudixDb): RateLimitRepository {
  return {
    async take(key, spec) {
      if (!(spec.capacity >= 1) || !(spec.refillPerSecond > 0)) {
        throw new RangeError("token bucket needs capacity >= 1 and refillPerSecond > 0");
      }
      // `refilled` is the balance after topping up since the last write; the row keeps one token fewer when allowed.
      const refilled = sql`least(${spec.capacity}::float8, b.tokens + extract(epoch from (now() - b.updated_at)) * ${spec.refillPerSecond}::float8)`;
      const rows = await db.execute<{ tokens: number; allowed: boolean }>(sql`
        insert into rate_limit_buckets as b (key, tokens, allowed, updated_at)
        values (${key}, ${spec.capacity}::float8 - 1, true, now())
        on conflict (key) do update set
          allowed = ${refilled} >= 1,
          tokens = case when ${refilled} >= 1 then ${refilled} - 1 else ${refilled} end,
          updated_at = now()
        returning tokens, allowed`);
      const row = rows[0];
      if (!row) throw new Error("rate limit bucket update returned no row");
      if (row.allowed) return { allowed: true, retryAfterSeconds: 0 };
      return { allowed: false, retryAfterSeconds: Math.ceil((1 - row.tokens) / spec.refillPerSecond) };
    },
    async prune() {
      const rows = await db.execute<{ key: string }>(
        sql`delete from rate_limit_buckets where updated_at < now() - ${IDLE_ROW_TTL}::interval returning key`,
      );
      return rows.length;
    },
  };
}
