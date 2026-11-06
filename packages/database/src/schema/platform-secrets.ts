import type { StudixErrorPayload } from "@studix/shared";
import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, updatedAt } from "./columns.ts";

export type PlatformSecretStatus = "available" | "invalid" | "unverified";

/** `at` is stored as an ISO string inside jsonb and revived as a Date by the repository. */
export interface StoredPlatformSecretTest {
  ok: boolean;
  at: string;
  latencyMs: number;
  step?: string;
  httpStatus?: number;
  error?: StudixErrorPayload;
}

/**
 * Platform-level credentials an operator manages from the dashboard: object-storage keys and the media
 * vendor keys the worker hands to Multix. Not tenant data, so there is no workspace column: one row per
 * allow-listed variable name (the allowlist lives in `@studix/auth`, never in this table). The value is
 * AES-256-GCM sealed with the same master key as provider connections, bound to the name; plaintext is never
 * stored. Revoking deletes the row (the audit log keeps the history), which returns the variable to whatever
 * the deployment environment holds.
 */
export const platformSecrets = pgTable("platform_secrets", {
  name: text("name").primaryKey(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  /** Non-secret display hint, e.g. `…a1b2`. */
  secretHint: text("secret_hint").notNull(),
  status: text("status").$type<PlatformSecretStatus>().notNull(),
  lastTest: jsonb("last_test").$type<StoredPlatformSecretTest>(),
  /** Bumped on every replacement, so a reader can tell which value it holds. */
  version: integer("version").notNull().default(1),
  updatedByType: text("updated_by_type").$type<ActorType>().notNull(),
  updatedById: text("updated_by_id").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
