import { boolean, doublePrecision, pgTable, text } from "drizzle-orm/pg-core";
import { updatedAt } from "./columns.ts";

/**
 * Token buckets shared by every app replica. The key carries scope and subject (`mcp-ws:<workspaceId>`,
 * `auth:<ip>`), so rows are not tenant-owned and hold no personal data beyond a client IP that expires with
 * the bucket. `granted` records whether the last take consumed a token, so a single upsert can report it.
 */
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  granted: boolean("granted").notNull().default(true),
  updatedAt: updatedAt(),
});
