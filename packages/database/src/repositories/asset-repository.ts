import {
  type Asset,
  type AssetRepository,
  type AssetVersion,
  normalizeAssetPath,
  organizeNewAsset,
} from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { desc, eq, ilike, max, or, sql } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { assets, assetVersions } from "../schema/projects.ts";
import { actorFrom, beforeCursor, first, opt, pageLimit, scoped, tenantValues, toPage } from "./helpers.ts";
import { activeStorageProfileSql } from "./storage-profile-repository.ts";

const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

/** The folder itself or anything below it; "" is every folder. */
function folderFilter(folder: string) {
  if (folder === "") return undefined;
  return or(eq(assets.path, folder), ilike(assets.path, `${escapeLike(folder)}/%`));
}

type AssetRow = typeof assets.$inferSelect;
type VersionRow = typeof assetVersions.$inferSelect;

function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: opt(row.projectId),
    kind: row.kind,
    role: row.role,
    path: row.path,
    tags: row.tags,
    name: row.name,
    currentVersionId: opt(row.currentVersionId),
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersion(row: VersionRow): AssetVersion {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    assetId: row.assetId,
    version: row.version,
    storageKey: row.storageKey,
    sha256: row.sha256,
    mime: row.mime,
    bytes: row.bytes,
    width: opt(row.width),
    height: opt(row.height),
    durationMs: opt(row.durationMs),
    provenance: row.provenance,
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
  };
}

export function createAssetRepository(db: StudixDb, clock: Clock): AssetRepository {
  return {
    async create(ctx, input) {
      const now = clock.now();
      const rows = await db
        .insert(assets)
        .values({
          id: input.id ?? newId("ast"),
          ...tenantValues(ctx),
          projectId: input.projectId ?? null,
          kind: input.kind,
          ...organizeNewAsset(input),
          name: input.name,
          createdByType: input.createdBy.type,
          createdById: input.createdBy.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toAsset(first(rows, "asset"));
    },

    async get(ctx, id) {
      const rows = await db
        .select()
        .from(assets)
        .where(scoped(assets, ctx, eq(assets.id, id)));
      return rows[0] ? toAsset(rows[0]) : undefined;
    },

    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(assets)
        .where(
          scoped(
            assets,
            ctx,
            beforeCursor(assets.id, query.cursor),
            query.projectId ? eq(assets.projectId, query.projectId) : undefined,
            query.kind ? eq(assets.kind, query.kind) : undefined,
            query.role ? eq(assets.role, query.role) : undefined,
            query.path === undefined ? undefined : folderFilter(normalizeAssetPath(query.path)),
            query.tag ? sql`${assets.tags} ? ${query.tag.trim().toLowerCase()}` : undefined,
            query.search ? ilike(assets.name, `%${escapeLike(query.search)}%`) : undefined,
          ),
        )
        .orderBy(desc(assets.id))
        .limit(limit + 1);
      return toPage(rows.map(toAsset), limit);
    },

    async addVersion(ctx, input) {
      return db.transaction(async (tx) => {
        const locked = await tx
          .select({ id: assets.id })
          .from(assets)
          .where(scoped(assets, ctx, eq(assets.id, input.assetId)))
          .for("update");
        if (locked.length === 0) throw new StudixError("NOT_FOUND", `asset ${input.assetId} not found`);
        const [current] = await tx
          .select({ version: max(assetVersions.version) })
          .from(assetVersions)
          .where(scoped(assetVersions, ctx, eq(assetVersions.assetId, input.assetId)));
        const now = clock.now();
        const rows = await tx
          .insert(assetVersions)
          .values({
            id: input.id ?? newId("astv"),
            ...tenantValues(ctx),
            assetId: input.assetId,
            version: (current?.version ?? 0) + 1,
            storageKey: input.storageKey,
            storageProfileId: activeStorageProfileSql(ctx.workspaceId),
            sha256: input.sha256,
            mime: input.mime,
            bytes: input.bytes,
            width: input.width ?? null,
            height: input.height ?? null,
            durationMs: input.durationMs ?? null,
            provenance: input.provenance,
            createdByType: input.createdBy.type,
            createdById: input.createdBy.id,
            createdAt: now,
          })
          .returning();
        const version = toVersion(first(rows, "asset version"));
        await tx
          .update(assets)
          .set({ currentVersionId: version.id, updatedAt: now })
          .where(scoped(assets, ctx, eq(assets.id, input.assetId)));
        return version;
      });
    },

    async getVersion(ctx, versionId) {
      const rows = await db
        .select()
        .from(assetVersions)
        .where(scoped(assetVersions, ctx, eq(assetVersions.id, versionId)));
      return rows[0] ? toVersion(rows[0]) : undefined;
    },

    async listVersions(ctx, assetId) {
      const rows = await db
        .select()
        .from(assetVersions)
        .where(scoped(assetVersions, ctx, eq(assetVersions.assetId, assetId)))
        .orderBy(desc(assetVersions.id));
      return rows.map(toVersion);
    },
  };
}
