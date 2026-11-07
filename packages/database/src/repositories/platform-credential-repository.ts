import type { ActorRef } from "@studix/core";
import type { Clock } from "@studix/shared";
import { eq, sql } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { platformCredentials, type StoredPlatformTest } from "../schema/platform-credentials.ts";

export interface PlatformTestRecord extends Omit<StoredPlatformTest, "at"> {
  at: Date;
}

export interface PlatformCredentialRecord {
  name: string;
  /** Sealed secret; only the platform credential service may open it. */
  secretCiphertext: string;
  secretHint: string;
  lastTest?: PlatformTestRecord;
  version: number;
  updatedBy: ActorRef;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlatformCredentialRepository {
  list(): Promise<PlatformCredentialRecord[]>;
  /** Insert or replace a credential; a replacement bumps `version` and clears the last test. */
  upsert(
    input: { name: string; secretCiphertext: string; secretHint: string },
    by: ActorRef,
  ): Promise<PlatformCredentialRecord>;
  /** Remove a credential; false when there was none. */
  delete(name: string): Promise<boolean>;
  /** Record a test result for an existing credential; false when it no longer exists. */
  recordTest(name: string, result: PlatformTestRecord): Promise<boolean>;
}

function toRecord(row: typeof platformCredentials.$inferSelect): PlatformCredentialRecord {
  return {
    name: row.name,
    secretCiphertext: row.secretCiphertext,
    secretHint: row.secretHint,
    ...(row.lastTest ? { lastTest: { ...row.lastTest, at: new Date(row.lastTest.at) } } : {}),
    version: row.version,
    updatedBy: { type: row.updatedByType, id: row.updatedById },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createPlatformCredentialRepository(db: StudixDb, clock: Clock): PlatformCredentialRepository {
  return {
    async list() {
      const rows = await db.select().from(platformCredentials).orderBy(platformCredentials.name);
      return rows.map(toRecord);
    },
    async upsert(input, by) {
      const now = clock.now();
      const rows = await db
        .insert(platformCredentials)
        .values({
          ...input,
          updatedByType: by.type,
          updatedById: by.id,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: platformCredentials.name,
          set: {
            secretCiphertext: input.secretCiphertext,
            secretHint: input.secretHint,
            lastTest: null,
            version: sql`${platformCredentials.version} + 1`,
            updatedByType: by.type,
            updatedById: by.id,
            updatedAt: now,
          },
        })
        .returning();
      return toRecord(rows[0]!);
    },
    async delete(name) {
      const rows = await db
        .delete(platformCredentials)
        .where(eq(platformCredentials.name, name))
        .returning({ name: platformCredentials.name });
      return rows.length > 0;
    },
    async recordTest(name, result) {
      const rows = await db
        .update(platformCredentials)
        .set({ lastTest: { ...result, at: result.at.toISOString() } })
        .where(eq(platformCredentials.name, name))
        .returning({ name: platformCredentials.name });
      return rows.length > 0;
    },
  };
}
