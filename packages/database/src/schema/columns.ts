import { text, timestamp } from "drizzle-orm/pg-core";

/**
 * Shared column builders. Ids are application-generated (`newId(prefix)`, time-sortable text), so
 * `ORDER BY id DESC` is creation order and keyset pagination can use `id < cursor`.
 */
export const id = () => text("id").primaryKey();
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const createdAt = () => ts("created_at").notNull().defaultNow();
export const updatedAt = () => ts("updated_at").notNull().defaultNow();

export type ActorType = "user" | "apiKey" | "oauth" | "system";
