import { type Clock, StudixError } from "@studix/shared";
import type { AssetLineage, NodeRevision, StageCacheEntry } from "../entities/revision.ts";
import type { ProjectRepository } from "../repositories/project-repository.ts";
import {
  invalidatedSince,
  irNodeSnapshots,
  type RevisionRepository,
  type StageCacheRepository,
} from "../repositories/revision-repositories.ts";
import type { TenantContext } from "../tenant.ts";
import { InMemoryTenantTable } from "./in-memory-table.ts";

export function createInMemoryRevisionRepository(
  clock: Clock,
  projects: Pick<ProjectRepository, "getVersion">,
): RevisionRepository {
  const revisions = new InMemoryTenantTable<NodeRevision>("nrev", clock, false);
  const lineage = new InMemoryTenantTable<AssetLineage>("lin", clock, false);
  /** versionId -> revision ids, per tenant through the revision rows themselves. */
  const versionNodes = new Map<string, string[]>();

  const listVersion = (ctx: TenantContext, versionId: string): NodeRevision[] =>
    (versionNodes.get(versionId) ?? []).flatMap((id) => revisions.get(ctx, id) ?? []);

  return {
    async recordVersion(ctx, versionId) {
      const version = await projects.getVersion(ctx, versionId);
      if (!version) throw new StudixError("NOT_FOUND", `project version ${versionId} not found`);
      if (!versionNodes.has(versionId)) {
        const ids = irNodeSnapshots(version.ir).map((node) => {
          const same = revisions.filter(
            ctx,
            (r) => r.projectId === version.projectId && r.kind === node.kind && r.nodeId === node.nodeId,
          );
          const existing = same.find((r) => r.digest === node.digest);
          if (existing) return existing.id;
          const revision = Math.max(0, ...same.map((r) => r.revision)) + 1;
          return revisions.insert(ctx, { ...node, projectId: version.projectId, revision, versionId }).id;
        });
        versionNodes.set(versionId, ids);
      }
      const recorded = listVersion(ctx, versionId);
      const parent = version.parentVersionId ? listVersion(ctx, version.parentVersionId) : undefined;
      return {
        versionId,
        revisions: recorded,
        invalidated: invalidatedSince(recorded, parent),
      };
    },
    async listVersionRevisions(ctx, versionId) {
      return listVersion(ctx, versionId);
    },
    async getRevision(ctx, id) {
      return revisions.get(ctx, id);
    },
    async addLineage(ctx, inputs) {
      return inputs.map((input) => {
        const existing = lineage.filter(
          ctx,
          (l) =>
            l.assetVersionId === input.assetVersionId &&
            l.inputKind === input.inputKind &&
            l.inputId === input.inputId,
        )[0];
        return existing ?? lineage.insert(ctx, input);
      });
    },
    async listLineage(ctx, assetVersionId) {
      return lineage.filter(ctx, (l) => l.assetVersionId === assetVersionId);
    },
    async derivedAssetVersions(ctx, inputs) {
      const found = new Set<string>();
      let frontier = inputs.map((i) => `${i.kind}:${i.id}`);
      while (frontier.length > 0) {
        const keys = new Set(frontier);
        const next = lineage
          .filter(ctx, (l) => keys.has(`${l.inputKind}:${l.inputId}`))
          .map((l) => l.assetVersionId)
          .filter((id) => !found.has(id));
        for (const id of next) found.add(id);
        frontier = next.map((id) => `asset_version:${id}`);
      }
      return [...found].sort();
    },
  };
}

export function createInMemoryStageCache(clock: Clock): StageCacheRepository {
  const entries = new InMemoryTenantTable<StageCacheEntry>("stc", clock, false);
  const find = (ctx: TenantContext, stage: string, cacheKey: string) =>
    entries.filter(ctx, (e) => e.stage === stage && e.cacheKey === cacheKey)[0];
  return {
    async get(ctx, stage, cacheKey) {
      return find(ctx, stage, cacheKey);
    },
    async put(ctx, input) {
      return find(ctx, input.stage, input.cacheKey) ?? entries.insert(ctx, input);
    },
  };
}
