import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, updatedAt } from "./columns.ts";

/** Result of the last connection test, kept beside the credential; `at` is an ISO string inside jsonb. */
export interface StoredPlatformTest {
  ok: boolean;
  at: string;
  /** Short, redacted diagnosis (never a key value). */
  detail?: string;
}

/**
 * Platform-level media credentials set by a platform operator from the dashboard: the vendor keys the
 * Multix CLI receives (`SUME_API_KEY`, ...). Not tenant data, so there is no workspace column. `name` is
 * the environment variable name from a fixed allowlist, and `secret_ciphertext` is AES-256-GCM sealed
 * (STUDIX_SECRETS_KEY, bound to the name); plaintext is never stored. A row overrides the process
 * environment variable of the same name; deleting the row revokes it. `version` increases on every rotation.
 */
export const platformCredentials = pgTable("platform_credentials", {
  name: text("name").primaryKey(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  /** Non-secret display hint (last characters). */
  secretHint: text("secret_hint").notNull(),
  lastTest: jsonb("last_test").$type<StoredPlatformTest>(),
  version: integer("version").notNull().default(1),
  updatedByType: text("updated_by_type").$type<ActorType>().notNull(),
  updatedById: text("updated_by_id").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
