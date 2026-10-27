import { boolean, doublePrecision, pgTable, text } from "drizzle-orm/pg-core";
import { ts } from "./columns.ts";

/**
 * Token buckets shared by every app replica. Keys are `<scope>:<subject>` (an IP or a workspace id), so the
 * table sits outside tenancy. `tokens` is the balance as of `updated_at`; `allowed` records the last decision.
 */
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  allowed: boolean("allowed").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
