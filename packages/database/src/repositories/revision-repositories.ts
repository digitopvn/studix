import {
  type AssetLineage,
  invalidatedSince,
  irNodeSnapshots,
  type NodeRevision,
  type RevisionRepository,
  type StageCacheEntry,
  type StageCacheRepository,
  type TenantContext,
} from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { and, asc, eq, max, or } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { projectVersions, videoProjects } from "../schema/projects.ts";
import { assetLineage, irNodeRevisions, projectVersionNodes, stageCache } from "../schema/revisions.ts";
import { first, opt, scoped, tenantValues } from "./helpers.ts";

type RevisionRow = typeof irNodeRevisions.$inferSelect;
type LineageRow = typeof assetLineage.$inferSelect;
type CacheRow = typeof stageCache.$inferSelect;

function toRevision(row: RevisionRow): NodeRevision {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    kind: row.kind,
    nodeId: row.nodeId,
    revision: row.revision,
    digest: row.digest,
    content: row.content,
    versionId: row.versionId,
    createdAt: row.createdAt,
  };
}

function toLineage(row: LineageRow): AssetLineage {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    assetVersionId: row.assetVersionId,
    inputKind: row.inputKind,
    inputId: row.inputId,
    role: opt(row.role),
    jobId: opt(row.jobId),
    createdAt: row.createdAt,
  };
}

function toCacheEntry(row: CacheRow): StageCacheEntry {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    stage: row.stage,
    cacheKey: row.cacheKey,
    output: row.output,
    jobId: opt(row.jobId),
    createdAt: row.createdAt,
  };
}

export function createRevisionRepository(db: StudixDb, clock: Clock): RevisionRepository {
  const listVersion = async (exec: Pick<StudixDb, "select">, ctx: TenantContext, versionId: string) => {
    const rows = await exec
      .select({ revision: irNodeRevisions })
      .from(projectVersionNodes)
      .innerJoin(irNodeRevisions, eq(irNodeRevisions.id, projectVersionNodes.revisionId))
      .where(scoped(projectVersionNodes, ctx, eq(projectVersionNodes.versionId, versionId)))
      .orderBy(asc(projectVersionNodes.position));
    return rows.map((r) => toRevision(r.revision));
  };

  return {
    async recordVersion(ctx, versionId) {
      const recorded = await db.transaction(async (tx) => {
        const [version] = await tx
          .select()
          .from(projectVersions)
          .where(scoped(projectVersions, ctx, eq(projectVersions.id, versionId)));
        if (!version) throw new StudixError("NOT_FOUND", `project version ${versionId} not found`);
        // Lock the project so concurrent recordings get distinct revision numbers.
        await tx
          .select({ id: videoProjects.id })
          .from(videoProjects)
          .where(scoped(videoProjects, ctx, eq(videoProjects.id, version.projectId)))
          .for("update");
        const existing = await listVersion(tx, ctx, versionId);
        if (existing.length > 0) return { version, revisions: existing };

        const revisions: NodeRevision[] = [];
        for (const [position, node] of irNodeSnapshots(version.ir).entries()) {
          const sameNode = and(
            eq(irNodeRevisions.projectId, version.projectId),
            eq(irNodeRevisions.kind, node.kind),
            eq(irNodeRevisions.nodeId, node.nodeId),
          );
          let [row] = await tx
            .select()
            .from(irNodeRevisions)
            .where(scoped(irNodeRevisions, ctx, sameNode, eq(irNodeRevisions.digest, node.digest)));
          if (!row) {
            const [latest] = await tx
              .select({ revision: max(irNodeRevisions.revision) })
              .from(irNodeRevisions)
              .where(scoped(irNodeRevisions, ctx, sameNode));
            const inserted = await tx
              .insert(irNodeRevisions)
              .values({
                id: newId("nrev"),
                ...tenantValues(ctx),
                projectId: version.projectId,
                kind: node.kind,
                nodeId: node.nodeId,
                revision: (latest?.revision ?? 0) + 1,
                digest: node.digest,
                content: node.content,
                versionId,
                createdAt: clock.now(),
              })
              .returning();
            row = first(inserted, "node revision");
          }
          await tx.insert(projectVersionNodes).values({
            ...tenantValues(ctx),
            versionId,
            kind: node.kind,
            nodeId: node.nodeId,
            position,
            revisionId: row.id,
          });
          revisions.push(toRevision(row));
        }
        return { version, revisions };
      });
      const parentId = recorded.version.parentVersionId;
      const parent = parentId ? await listVersion(db, ctx, parentId) : undefined;
      return {
        versionId,
        revisions: recorded.revisions,
        invalidated: invalidatedSince(recorded.revisions, parent),
      };
    },

    async listVersionRevisions(ctx, versionId) {
      return listVersion(db, ctx, versionId);
    },

    async getRevision(ctx, id) {
      const rows = await db
        .select()
        .from(irNodeRevisions)
        .where(scoped(irNodeRevisions, ctx, eq(irNodeRevisions.id, id)));
      return rows[0] ? toRevision(rows[0]) : undefined;
    },

    async addLineage(ctx, inputs) {
      if (inputs.length === 0) return [];
      await db
        .insert(assetLineage)
        .values(
          inputs.map((input) => ({
            id: input.id ?? newId("lin"),
            ...tenantValues(ctx),
            assetVersionId: input.assetVersionId,
            inputKind: input.inputKind,
            inputId: input.inputId,
            role: input.role ?? null,
            jobId: input.jobId ?? null,
            createdAt: clock.now(),
          })),
        )
        .onConflictDoNothing();
      const rows = await db
        .select()
        .from(assetLineage)
        .where(
          scoped(
            assetLineage,
            ctx,
            or(
              ...inputs.map((i) =>
                and(
                  eq(assetLineage.assetVersionId, i.assetVersionId),
                  eq(assetLineage.inputKind, i.inputKind),
                  eq(assetLineage.inputId, i.inputId),
                ),
              ),
            ),
          ),
        );
      const key = (l: { assetVersionId: string; inputKind: string; inputId: string }) =>
        `${l.assetVersionId}|${l.inputKind}|${l.inputId}`;
      const byKey = new Map(rows.map((r) => [key(r), toLineage(r)]));
      return inputs.map((i) => byKey.get(key(i)) as AssetLineage);
    },

    async listLineage(ctx, assetVersionId) {
      const rows = await db
        .select()
        .from(assetLineage)
        .where(scoped(assetLineage, ctx, eq(assetLineage.assetVersionId, assetVersionId)))
        .orderBy(asc(assetLineage.id));
      return rows.map(toLineage);
    },

    async derivedAssetVersions(ctx, inputs) {
      const found = new Set<string>();
      let frontier = inputs;
      while (frontier.length > 0) {
        const rows = await db
          .select({ assetVersionId: assetLineage.assetVersionId })
          .from(assetLineage)
          .where(
            scoped(
              assetLineage,
              ctx,
              or(
                ...frontier.map((i) =>
                  and(eq(assetLineage.inputKind, i.kind), eq(assetLineage.inputId, i.id)),
                ),
              ),
            ),
          );
        const next = [...new Set(rows.map((r) => r.assetVersionId))].filter((id) => !found.has(id));
        for (const id of next) found.add(id);
        frontier = next.map((id) => ({ kind: "asset_version" as const, id }));
      }
      return [...found].sort();
    },
  };
}

export function createStageCacheRepository(db: StudixDb, clock: Clock): StageCacheRepository {
  const find = async (ctx: TenantContext, stage: string, cacheKey: string) => {
    const rows = await db
      .select()
      .from(stageCache)
      .where(scoped(stageCache, ctx, eq(stageCache.stage, stage), eq(stageCache.cacheKey, cacheKey)));
    return rows[0] ? toCacheEntry(rows[0]) : undefined;
  };
  return {
    get: find,
    async put(ctx, input) {
      await db
        .insert(stageCache)
        .values({
          id: input.id ?? newId("stc"),
          ...tenantValues(ctx),
          stage: input.stage,
          cacheKey: input.cacheKey,
          output: input.output,
          jobId: input.jobId ?? null,
          createdAt: clock.now(),
        })
        .onConflictDoNothing();
      const stored = await find(ctx, input.stage, input.cacheKey);
      if (!stored) throw new StudixError("INTERNAL", `stage cache entry ${input.stage} was not stored`);
      return stored;
    },
  };
}
