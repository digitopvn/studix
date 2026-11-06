import type { ActorRef } from "@studix/core";
import { eq, sql } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { platformCredentials, type StoredPlatformCredentialTest } from "../schema/platform-credentials.ts";

export interface PlatformCredentialRecord {
  name: string;
  status: "active" | "revoked";
  /** Sealed secret; only the service that holds the secrets key may open it. Never returned to clients. */
  secretCiphertext?: string;
  secretHint?: string;
  lastTest?: StoredPlatformCredentialTest;
  version: number;
  updatedBy: ActorRef;
  updatedAt: Date;
  revokedAt?: Date;
}

export interface PlatformCredentialRepository {
  list(): Promise<PlatformCredentialRecord[]>;
  get(name: string): Promise<PlatformCredentialRecord | undefined>;
  /** Store a sealed secret, replacing the active or revoked row; the version increases. */
  save(
    name: string,
    value: { secretCiphertext: string; secretHint: string },
    by: ActorRef,
  ): Promise<PlatformCredentialRecord>;
  /** Drop the secret and keep a `revoked` marker (created when nothing was stored, so an env value is switched off too). */
  revoke(name: string, by: ActorRef): Promise<PlatformCredentialRecord>;
  recordTest(name: string, result: StoredPlatformCredentialTest): Promise<void>;
}

function toRecord(row: typeof platformCredentials.$inferSelect): PlatformCredentialRecord {
  return {
    name: row.name,
    status: row.status,
    ...(row.secretCiphertext ? { secretCiphertext: row.secretCiphertext } : {}),
    ...(row.secretHint ? { secretHint: row.secretHint } : {}),
    ...(row.lastTest ? { lastTest: row.lastTest } : {}),
    version: row.version,
    updatedBy: { type: row.updatedByType, id: row.updatedById } as ActorRef,
    updatedAt: row.updatedAt,
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  };
}

export function createPlatformCredentialRepository(db: StudixDb): PlatformCredentialRepository {
  return {
    async list() {
      return (await db.select().from(platformCredentials)).map(toRecord);
    },
    async get(name) {
      const rows = await db.select().from(platformCredentials).where(eq(platformCredentials.name, name));
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
    async save(name, value, by) {
      const now = new Date();
      const set = {
        status: "active" as const,
        secretCiphertext: value.secretCiphertext,
        secretHint: value.secretHint,
        lastTest: null,
        revokedAt: null,
        updatedByType: by.type,
        updatedById: by.id,
        updatedAt: now,
      };
      const rows = await db
        .insert(platformCredentials)
        .values({ name, ...set, version: 1 })
        .onConflictDoUpdate({
          target: platformCredentials.name,
          set: { ...set, version: sqlIncrement() },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("platform credential upsert failed");
      return toRecord(row);
    },
    async revoke(name, by) {
      const now = new Date();
      const set = {
        status: "revoked" as const,
        secretCiphertext: null,
        secretHint: null,
        lastTest: null,
        revokedAt: now,
        updatedByType: by.type,
        updatedById: by.id,
        updatedAt: now,
      };
      const rows = await db
        .insert(platformCredentials)
        .values({ name, ...set, version: 1 })
        .onConflictDoUpdate({ target: platformCredentials.name, set: { ...set, version: sqlIncrement() } })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("platform credential revoke failed");
      return toRecord(row);
    },
    async recordTest(name, result) {
      await db
        .update(platformCredentials)
        .set({ lastTest: result })
        .where(eq(platformCredentials.name, name));
    },
  };
}

function sqlIncrement() {
  return sql`${platformCredentials.version} + 1`;
}
