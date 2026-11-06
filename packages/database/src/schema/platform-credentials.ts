import { index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, ts, updatedAt } from "./columns.ts";

/** Outcome of the last connectivity check, stored as jsonb; `at` is an ISO string. */
export interface StoredPlatformCredentialTest {
  ok: boolean;
  at: string;
  /** Short machine-readable outcome such as `found`, `missing` or `unavailable`. */
  outcome: string;
  message?: string;
}

export type PlatformCredentialStatus = "active" | "revoked";

/**
 * Platform-wide (not tenant-scoped) credentials the operator manages from the dashboard: today the media
 * vendor keys Studix passes to the Multix CLI. `name` is the environment variable the CLI reads, restricted
 * to an allowlist by the service. `secret_ciphertext` is AES-256-GCM sealed with the app's secrets key,
 * bound to the row name; plaintext never reaches the database. A `revoked` row has no ciphertext and also
 * suppresses an environment fallback for that name, so a revoked key stays off until a new one is saved.
 */
export const platformCredentials = pgTable(
  "platform_credentials",
  {
    name: text("name").primaryKey(),
    status: text("status").$type<PlatformCredentialStatus>().notNull(),
    secretCiphertext: text("secret_ciphertext"),
    /** Non-secret display hint such as `…a1b2`. */
    secretHint: text("secret_hint"),
    lastTest: jsonb("last_test").$type<StoredPlatformCredentialTest>(),
    /** Increases on every save or revoke so processes can tell which configuration they applied. */
    version: integer("version").notNull().default(1),
    updatedByType: text("updated_by_type").$type<ActorType>().notNull(),
    updatedById: text("updated_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("platform_credentials_updated_idx").on(t.updatedAt)],
);
