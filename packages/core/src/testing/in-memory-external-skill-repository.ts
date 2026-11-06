import type { Clock } from "@studix/shared";
import type { ExternalSkill, ExternalSkillVersion } from "../entities/external-skill.ts";
import type { ExternalSkillRepository } from "../repositories/external-skill-repository.ts";
import type { TenantContext } from "../tenant.ts";
import { InMemoryTenantTable } from "./in-memory-table.ts";

/**
 * In-memory external skills with the same rules as Postgres. Each import runs without awaiting, so it is
 * atomic on the event loop the way the database transaction is.
 */
export function createInMemoryExternalSkillRepository(clock: Clock): ExternalSkillRepository {
  const skills = new InMemoryTenantTable<ExternalSkill>("xsk", clock);
  const versions = new InMemoryTenantTable<ExternalSkillVersion>("xsv", clock, false);
  const bySource = (ctx: TenantContext, repository: string, skillPath: string) =>
    skills.filter(ctx, (s) => s.repository === repository.toLowerCase() && s.skillPath === skillPath)[0];
  const update = (ctx: TenantContext, skillId: string, patch: Partial<ExternalSkill>) =>
    skills.get(ctx, skillId) ? skills.update(ctx, skillId, patch) : undefined;

  return {
    async get(ctx, skillId) {
      return skills.get(ctx, skillId);
    },
    async findBySource(ctx, repository, skillPath) {
      return bySource(ctx, repository, skillPath);
    },
    async list(ctx, query = {}) {
      const text = query.query?.trim().toLowerCase();
      const repository = query.repository?.toLowerCase();
      return skills.page(
        ctx,
        query,
        (s) =>
          (query.enabled === undefined || s.enabled === query.enabled) &&
          (repository === undefined || s.repository === repository) &&
          (!text || [s.name, s.description, s.repository].some((field) => field.toLowerCase().includes(text))),
      );
    },
    async getVersion(ctx, skillId, versionId) {
      const version = versions.get(ctx, versionId);
      return version?.skillId === skillId ? version : undefined;
    },
    async listVersions(ctx, skillId, query = {}) {
      return versions.page(ctx, query, (v) => v.skillId === skillId);
    },
    async importVersion(ctx, input) {
      const repository = input.repository.toLowerCase();
      const found = bySource(ctx, repository, input.skillPath);
      const skillCreated = found === undefined;
      const skill =
        found ??
        skills.insert(ctx, {
        id: input.skillId,
        repository,
        skillPath: input.skillPath,
        name: input.name,
        description: input.description,
        enabled: true,
        upstreamStatus: "unknown",
        createdBy: input.createdBy,
      });
      const existing = versions.filter(
        ctx,
        (v) => v.skillId === skill.id && v.contentHash === input.contentHash,
      )[0];
      if (existing) {
        return { skill, version: existing, outcome: "unchanged", skillCreated, activated: false };
      }
      const version = versions.insert(ctx, {
        id: input.versionId,
        skillId: skill.id,
        commitSha: input.commitSha,
        contentHash: input.contentHash,
        name: input.name,
        description: input.description,
        manifest: input.manifest,
        skillStorageKey: input.skillStorageKey,
        createdBy: input.createdBy,
      });
      if (skill.activeVersionId !== undefined) {
        return { skill, version, outcome: "created", skillCreated, activated: false };
      }
      const activated = skills.update(ctx, skill.id, {
        activeVersionId: version.id,
        name: version.name,
        description: version.description,
      });
      return { skill: activated, version, outcome: "created", skillCreated, activated: true };
    },
    async activateVersion(ctx, skillId, versionId) {
      const version = versions.get(ctx, versionId);
      if (version?.skillId !== skillId) return undefined;
      return update(ctx, skillId, {
        activeVersionId: version.id,
        name: version.name,
        description: version.description,
      });
    },
    async setEnabled(ctx, skillId, enabled) {
      return update(ctx, skillId, { enabled });
    },
    async recordUpstreamCheck(ctx, skillId, check) {
      return update(ctx, skillId, {
        upstreamStatus: check.status,
        upstreamCheckedAt: check.checkedAt,
        upstreamCommitSha: check.commitSha,
      });
    },
  };
}
