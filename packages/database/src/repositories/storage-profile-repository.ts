import type { ActorRef, TenantContext } from "@studix/core";
import { type Clock, newId } from "@studix/shared";
import { and, count, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { assetVersions, renders } from "../schema/projects.ts";
import { storageProfiles } from "../schema/storage-profiles.ts";
import type { PlatformTestRecord } from "./platform-credential-repository.ts";

export type StorageProviderTypeName = "cloudflare-r2" | "aws-s3" | "s3-compatible";

export interface StorageProfileRecord {
  id: string;
  /** Owning workspace; absent for a platform profile. */
  workspaceId?: string;
  name: string;
  providerType: StorageProviderTypeName;
  endpoint?: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
  keyPrefix: string;
  /** Sealed; only the storage profile service may open them. */
  accessKeyCiphertext: string;
  secretCiphertext: string;
  accessKeyHint: string;
  secretHint: string;
  active: boolean;
  lastTest?: PlatformTestRecord;
  version: number;
  updatedBy: ActorRef;
  createdAt: Date;
  updatedAt: Date;
}

export interface StorageProfileInput {
  name: string;
  providerType: StorageProviderTypeName;
  endpoint?: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
  keyPrefix: string;
}

export interface SealedStorageKey {
  accessKeyCiphertext: string;
  secretCiphertext: string;
  accessKeyHint: string;
  secretHint: string;
}

/** Platform profiles (`undefined`) or one workspace's own profiles. */
export type StorageProfileScope = string | undefined;

export interface StorageProfileRepository {
  /** Every profile of every scope, for the routers. */
  list(): Promise<StorageProfileRecord[]>;
  /** Profiles of one scope. */
  listScope(workspaceId: StorageProfileScope): Promise<StorageProfileRecord[]>;
  get(id: string): Promise<StorageProfileRecord | undefined>;
  create(
    input: StorageProfileInput & SealedStorageKey & { id: string; workspaceId?: string },
    by: ActorRef,
  ): Promise<StorageProfileRecord>;
  /** Replace the settings and, when given, the key pair; bumps `version` and clears the last test. */
  update(
    id: string,
    input: StorageProfileInput & Partial<SealedStorageKey>,
    by: ActorRef,
  ): Promise<StorageProfileRecord | undefined>;
  /**
   * Make `id` the only active profile of its scope, or deactivate every profile of the scope when `id` is
   * undefined (a workspace then follows the platform choice; the platform falls back to `env`).
   */
  activate(id: string | undefined, by: ActorRef, workspaceId?: StorageProfileScope): Promise<void>;
  /** Delete an inactive profile; false when there is no such inactive profile. */
  delete(id: string): Promise<boolean>;
  recordTest(id: string, result: PlatformTestRecord): Promise<boolean>;
  /** Asset versions and renders that store their bytes in the profile. */
  countReferences(id: string): Promise<number>;
  /** The profile a tenant's stored object records (asset version first, then render). */
  locate(
    ctx: Pick<TenantContext, "organizationId" | "workspaceId">,
    key: string,
  ): Promise<string | undefined>;
}

/**
 * Profile a new row of `workspaceId` records: the workspace's active profile, else the platform's active profile,
 * else the environment settings (`env`).
 */
export function activeStorageProfileSql(workspaceId: string): SQL<string> {
  return sql<string>`coalesce(
    (select ${storageProfiles.id} from ${storageProfiles} where ${storageProfiles.active} and ${storageProfiles.workspaceId} = ${workspaceId} limit 1),
    (select ${storageProfiles.id} from ${storageProfiles} where ${storageProfiles.active} and ${storageProfiles.workspaceId} is null limit 1),
    'env')`;
}

function inScope(workspaceId: StorageProfileScope): SQL {
  return workspaceId === undefined
    ? isNull(storageProfiles.workspaceId)
    : eq(storageProfiles.workspaceId, workspaceId);
}

export function newStorageProfileId(): string {
  return newId("stp");
}

function toRecord(row: typeof storageProfiles.$inferSelect): StorageProfileRecord {
  return {
    id: row.id,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    name: row.name,
    providerType: row.providerType,
    ...(row.endpoint ? { endpoint: row.endpoint } : {}),
    bucket: row.bucket,
    region: row.region,
    forcePathStyle: row.forcePathStyle,
    keyPrefix: row.keyPrefix,
    accessKeyCiphertext: row.accessKeyCiphertext,
    secretCiphertext: row.secretCiphertext,
    accessKeyHint: row.accessKeyHint,
    secretHint: row.secretHint,
    active: row.active,
    ...(row.lastTest ? { lastTest: { ...row.lastTest, at: new Date(row.lastTest.at) } } : {}),
    version: row.version,
    updatedBy: { type: row.updatedByType, id: row.updatedById },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createStorageProfileRepository(db: StudixDb, clock: Clock): StorageProfileRepository {
  return {
    async list() {
      const rows = await db.select().from(storageProfiles).orderBy(desc(storageProfiles.createdAt));
      return rows.map(toRecord);
    },
    async listScope(workspaceId) {
      const rows = await db
        .select()
        .from(storageProfiles)
        .where(inScope(workspaceId))
        .orderBy(desc(storageProfiles.createdAt));
      return rows.map(toRecord);
    },
    async get(id) {
      const rows = await db.select().from(storageProfiles).where(eq(storageProfiles.id, id));
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
    async create(input, by) {
      const now = clock.now();
      const rows = await db
        .insert(storageProfiles)
        .values({
          ...input,
          workspaceId: input.workspaceId ?? null,
          endpoint: input.endpoint ?? null,
          active: false,
          updatedByType: by.type,
          updatedById: by.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toRecord(rows[0]!);
    },
    async update(id, input, by) {
      const rows = await db
        .update(storageProfiles)
        .set({
          ...input,
          endpoint: input.endpoint ?? null,
          lastTest: null,
          version: sql`${storageProfiles.version} + 1`,
          updatedByType: by.type,
          updatedById: by.id,
          updatedAt: clock.now(),
        })
        .where(eq(storageProfiles.id, id))
        .returning();
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
    async activate(id, by, workspaceId) {
      await db.transaction(async (tx) => {
        const now = clock.now();
        const who = { updatedByType: by.type, updatedById: by.id, updatedAt: now };
        await tx
          .update(storageProfiles)
          .set({ active: false, ...who })
          .where(and(eq(storageProfiles.active, true), inScope(workspaceId)));
        if (id)
          await tx
            .update(storageProfiles)
            .set({ active: true, ...who })
            .where(and(eq(storageProfiles.id, id), inScope(workspaceId)));
      });
    },
    async delete(id) {
      const rows = await db
        .delete(storageProfiles)
        .where(and(eq(storageProfiles.id, id), eq(storageProfiles.active, false)))
        .returning({ id: storageProfiles.id });
      return rows.length > 0;
    },
    async recordTest(id, result) {
      const rows = await db
        .update(storageProfiles)
        .set({ lastTest: { ...result, at: result.at.toISOString() } })
        .where(eq(storageProfiles.id, id))
        .returning({ id: storageProfiles.id });
      return rows.length > 0;
    },
    async countReferences(id) {
      const [versions] = await db
        .select({ n: count() })
        .from(assetVersions)
        .where(eq(assetVersions.storageProfileId, id));
      const [outputs] = await db.select({ n: count() }).from(renders).where(eq(renders.storageProfileId, id));
      return (versions?.n ?? 0) + (outputs?.n ?? 0);
    },
    async locate(ctx, key) {
      const [version] = await db
        .select({ id: assetVersions.storageProfileId })
        .from(assetVersions)
        .where(
          and(
            eq(assetVersions.organizationId, ctx.organizationId),
            eq(assetVersions.workspaceId, ctx.workspaceId),
            eq(assetVersions.storageKey, key),
          ),
        )
        .limit(1);
      if (version) return version.id;
      const [render] = await db
        .select({ id: renders.storageProfileId })
        .from(renders)
        .where(
          and(
            eq(renders.organizationId, ctx.organizationId),
            eq(renders.workspaceId, ctx.workspaceId),
            eq(renders.storageKey, key),
          ),
        )
        .limit(1);
      return render?.id;
    },
  };
}
