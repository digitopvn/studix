import { type Clock, StudixError } from "@studix/shared";
import type { Asset, AssetVersion } from "../entities/asset.ts";
import type { ProjectVersion, VideoProject } from "../entities/project.ts";
import type { AssetRepository } from "../repositories/asset-repository.ts";
import { pageLimit, toPage } from "../repositories/pagination.ts";
import type { ProjectRepository } from "../repositories/project-repository.ts";
import { InMemoryTenantTable } from "./in-memory-table.ts";

export function createInMemoryProjectRepository(clock: Clock): ProjectRepository {
  const projects = new InMemoryTenantTable<VideoProject>("prj", clock);
  const versions = new InMemoryTenantTable<ProjectVersion>("pver", clock, false);
  return {
    async create(ctx, input) {
      return projects.insert(ctx, input);
    },
    async get(ctx, id) {
      return projects.get(ctx, id);
    },
    async list(ctx, query = {}) {
      return projects.page(ctx, query, (p) => query.status === undefined || p.status === query.status);
    },
    async update(ctx, id, patch) {
      return projects.update(ctx, id, patch);
    },
    async delete(ctx, id) {
      for (const v of versions.filter(ctx, (row) => row.projectId === id)) versions.delete(ctx, v.id);
      return projects.delete(ctx, id);
    },
    async createVersion(ctx, input) {
      const project = projects.require(ctx, input.projectId);
      const { advanceFromVersionId, ...fields } = input;
      if (advanceFromVersionId !== undefined && project.currentVersionId !== advanceFromVersionId) {
        throw new StudixError("CONFLICT", `version ${advanceFromVersionId} is no longer current`, {
          details: { currentVersionId: project.currentVersionId },
          suggestedAction: "Review the current version and send the change against it.",
        });
      }
      const existing = versions.filter(ctx, (v) => v.projectId === input.projectId);
      const version = Math.max(0, ...existing.map((v) => v.version)) + 1;
      const created = versions.insert(ctx, { ...fields, version });
      if (advanceFromVersionId !== undefined)
        projects.update(ctx, input.projectId, { currentVersionId: created.id });
      return created;
    },
    async getVersion(ctx, versionId) {
      return versions.get(ctx, versionId);
    },
    async listVersions(ctx, projectId, query = {}) {
      return versions.page(ctx, query, (v) => v.projectId === projectId);
    },
  };
}

export function createInMemoryAssetRepository(clock: Clock): AssetRepository {
  const assets = new InMemoryTenantTable<Asset>("ast", clock);
  const versions = new InMemoryTenantTable<AssetVersion>("astv", clock, false);
  return {
    async create(ctx, input) {
      return assets.insert(ctx, input);
    },
    async get(ctx, id) {
      return assets.get(ctx, id);
    },
    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const rows = assets
        .filter(
          ctx,
          (a) =>
            (query.projectId === undefined || a.projectId === query.projectId) &&
            (query.kind === undefined || a.kind === query.kind) &&
            (query.cursor === undefined || a.id < query.cursor),
        )
        .slice(0, limit + 1);
      return toPage(rows, limit);
    },
    async addVersion(ctx, input) {
      if (!assets.get(ctx, input.assetId))
        throw new StudixError("NOT_FOUND", `asset ${input.assetId} not found`);
      const existing = versions.filter(ctx, (v) => v.assetId === input.assetId);
      const version = Math.max(0, ...existing.map((v) => v.version)) + 1;
      const row = versions.insert(ctx, { ...input, version });
      assets.update(ctx, input.assetId, { currentVersionId: row.id });
      return row;
    },
    async getVersion(ctx, versionId) {
      return versions.get(ctx, versionId);
    },
    async listVersions(ctx, assetId) {
      return versions.filter(ctx, (v) => v.assetId === assetId);
    },
  };
}
