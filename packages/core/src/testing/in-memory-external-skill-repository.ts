import type { Clock } from "@studix/shared";
import type { ExternalSkill, ExternalSkillVersion } from "../entities/external-skill.ts";
import type { ExternalSkillRepository } from "../repositories/external-skill-repository.ts";
import { InMemoryTenantTable } from "./in-memory-table.ts";

/** In-memory external skill store with the same uniqueness and tenant rules as Postgres. */
export function createInMemoryExternalSkillRepository(clock: Clock): ExternalSkillRepository {
  const skills = new InMemoryTenantTable<ExternalSkill>("xsk", clock);
  const versions = new InMemoryTenantTable<ExternalSkillVersion>("xsv", clock, false);

  const matches = (
    skill: ExternalSkill,
    query: { query?: string; repository?: string; enabled?: boolean },
  ) => {
    if (query.enabled !== undefined && skill.enabled !== query.enabled) return false;
    if (query.repository !== undefined) {
      const repo = `${skill.source.owner}/${skill.source.repo}`.toLowerCase();
      if (repo !== query.repository.toLowerCase()) return false;
    }
    if (query.query) {
      const needle = query.query.toLowerCase();
      if (!`${skill.name}\n${skill.description}`.toLowerCase().includes(needle)) return false;
    }
    return true;
  };

  return {
    async recordVersion(ctx, input) {
      let skill = skills.filter(ctx, (s) => s.sourceKey === input.sourceKey)[0];
      const existing = skill
        ? versions.filter(ctx, (v) => v.skillId === skill?.id && v.contentHash === input.contentHash)[0]
        : undefined;
      if (skill && existing) return { skill, version: existing, outcome: "unchanged" };

      const siblings = skill ? versions.filter(ctx, (v) => v.skillId === skill?.id) : [];
      const number = siblings.reduce((max, v) => Math.max(max, v.version), 0) + 1;
      const created = skill === undefined;
      const base =
        skill ??
        skills.insert(ctx, {
          sourceKey: input.sourceKey,
          source: input.source,
          name: input.name,
          description: input.description,
          enabled: true,
          latestVersionId: "pending",
          upstreamStatus: "current",
          createdBy: input.importedBy,
        });
      skill = base;
      const version = versions.insert(ctx, {
        skillId: skill.id,
        version: number,
        commitSha: input.commitSha,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        contentHash: input.contentHash,
        name: input.name,
        description: input.description,
        manifest: input.manifest,
        importedBy: input.importedBy,
      });
      const activate = input.activate || created || skill.activeVersionId === undefined;
      skill = skills.update(ctx, skill.id, {
        latestVersionId: version.id,
        upstreamStatus: "current",
        ...(activate
          ? { activeVersionId: version.id, name: input.name, description: input.description }
          : {}),
      });
      return { skill, version, outcome: created ? "created" : "new_version" };
    },
    async get(ctx, id) {
      return skills.get(ctx, id);
    },
    async findBySourceKey(ctx, sourceKey) {
      return skills.filter(ctx, (s) => s.sourceKey === sourceKey)[0];
    },
    async findByName(ctx, name, exceptId) {
      return skills.filter(ctx, (s) => s.name === name && s.id !== exceptId);
    },
    async list(ctx, query = {}) {
      return skills.page(ctx, query, (s) => matches(s, query));
    },
    async getVersion(ctx, skillId, versionId) {
      const version = versions.get(ctx, versionId);
      return version?.skillId === skillId ? version : undefined;
    },
    async listVersions(ctx, skillId, query = {}) {
      return versions.page(ctx, query, (v) => v.skillId === skillId);
    },
    async activateVersion(ctx, skillId, versionId) {
      const version = versions.get(ctx, versionId);
      if (!skills.get(ctx, skillId) || version?.skillId !== skillId) return undefined;
      return skills.update(ctx, skillId, {
        activeVersionId: version.id,
        name: version.name,
        description: version.description,
      });
    },
    async setEnabled(ctx, skillId, enabled, by) {
      if (!skills.get(ctx, skillId)) return undefined;
      return skills.update(ctx, skillId, {
        enabled,
        ...(enabled
          ? { disabledAt: undefined, disabledBy: undefined }
          : { disabledAt: clock.now(), disabledBy: by }),
      });
    },
    async setUpstreamStatus(ctx, skillId, status) {
      if (!skills.get(ctx, skillId)) return undefined;
      return skills.update(ctx, skillId, { upstreamStatus: status, upstreamCheckedAt: clock.now() });
    },
  };
}
