import type { ActorRef } from "@studix/core";
import { type Clock, systemClock } from "@studix/shared";
import { eq, sql } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import {
  type PlatformSecretStatus,
  platformSecrets,
  type StoredPlatformSecretTest,
} from "../schema/platform-secrets.ts";

export interface PlatformSecretTestRecord extends Omit<StoredPlatformSecretTest, "at"> {
  at: Date;
}

export interface PlatformSecretRecord {
  name: string;
  /** Sealed value; only the platform credential service may open it. */
  secretCiphertext: string;
  secretHint: string;
  status: PlatformSecretStatus;
  lastTest?: PlatformSecretTestRecord;
  version: number;
  updatedBy: ActorRef;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlatformSecretWrite {
  secretCiphertext: string;
  secretHint: string;
  status: PlatformSecretStatus;
  lastTest?: PlatformSecretTestRecord;
}

export interface PlatformSecretRepository {
  list(): Promise<PlatformSecretRecord[]>;
  get(name: string): Promise<PlatformSecretRecord | undefined>;
  /** Insert or replace the value of `name`; a replacement bumps `version`. */
  put(name: string, input: PlatformSecretWrite, by: ActorRef): Promise<PlatformSecretRecord>;
  /** Record a test outcome without touching the value; resolves undefined when the row is gone. */
  recordTest(
    name: string,
    status: PlatformSecretStatus,
    test: PlatformSecretTestRecord,
  ): Promise<PlatformSecretRecord | undefined>;
  /** Returns true when a row was removed. */
  delete(name: string): Promise<boolean>;
}

function toStored(test: PlatformSecretTestRecord): StoredPlatformSecretTest {
  return { ...test, at: test.at.toISOString() };
}

function toRecord(row: typeof platformSecrets.$inferSelect): PlatformSecretRecord {
  return {
    name: row.name,
    secretCiphertext: row.secretCiphertext,
    secretHint: row.secretHint,
    status: row.status,
    ...(row.lastTest ? { lastTest: { ...row.lastTest, at: new Date(row.lastTest.at) } } : {}),
    version: row.version,
    updatedBy: { type: row.updatedByType, id: row.updatedById },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createPlatformSecretRepository(
  db: StudixDb,
  clock: Clock = systemClock,
): PlatformSecretRepository {
  return {
    async list() {
      return (await db.select().from(platformSecrets).orderBy(platformSecrets.name)).map(toRecord);
    },
    async get(name) {
      const rows = await db.select().from(platformSecrets).where(eq(platformSecrets.name, name));
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
    async put(name, input, by) {
      const now = clock.now();
      const values = {
        secretCiphertext: input.secretCiphertext,
        secretHint: input.secretHint,
        status: input.status,
        lastTest: input.lastTest ? toStored(input.lastTest) : null,
        updatedByType: by.type,
        updatedById: by.id,
        updatedAt: now,
      };
      const rows = await db
        .insert(platformSecrets)
        .values({ name, ...values, createdAt: now })
        .onConflictDoUpdate({
          target: platformSecrets.name,
          set: { ...values, version: sql`${platformSecrets.version} + 1` },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("platform secret upsert failed");
      return toRecord(row);
    },
    async recordTest(name, status, test) {
      const rows = await db
        .update(platformSecrets)
        .set({ status, lastTest: toStored(test) })
        .where(eq(platformSecrets.name, name))
        .returning();
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
    async delete(name) {
      const rows = await db
        .delete(platformSecrets)
        .where(eq(platformSecrets.name, name))
        .returning({ name: platformSecrets.name });
      return rows.length > 0;
    },
  };
}
