import { type Clock, StudixError } from "@studix/shared";
import type { ExternalSkill, ExternalSkillVersion } from "../entities/external-skill.ts";
import type { ExternalSkillRepository } from "../repositories/external-skill-repository.ts";
import type { AuditRepository } from "../repositories/governance-repositories.ts";
import { type Page, pageLimit, toPage } from "../repositories/pagination.ts";
import type { TenantContext } from "../tenant.ts";
import { InMemoryTenantTable } from "./in-memory-table.ts";

/** In-memory external skills with the same rules as Postgres (one skill per source, versions by content). */
export function createInMemoryExternalSkillRepository(
  clock: Clock,
  audit?: AuditRepository,
): ExternalSkillRepository {
  const skills = new InMemoryTenantTable<ExternalSkill>("esk", clock);
  const versions = new InMemoryTenantTable<ExternalSkillVersion>("eskv", clock, false);

  const record = async (
    ctx: TenantContext,
    actor: ExternalSkill["createdBy"],
    action: string,
    subjectId: string,
    data?: Record<string, unknown>,
  ) => {
    await audit?.append(ctx, {
      actor,
      action,
      subjectType: "external_skill",
      subjectId,
      ...(data ? { data } : {}),
    });
  };
  const requireSkill = (ctx: TenantContext, id: string) => {
    const skill = skills.get(ctx, id);
    if (!skill) throw new StudixError("NOT_FOUND", `Skill ${id} not found`);
    return skill;
  };
  const listPage = <T extends { id: string }>(
    rows: T[],
    query: { limit?: number; cursor?: string },
  ): Page<T> => {
    const limit = pageLimit(query.limit);
    return toPage(
      rows.filter((r) => query.cursor === undefined || r.id < query.cursor).slice(0, limit + 1),
      limit,
    );
  };

  return {
    async get(ctx, id) {
      return skills.get(ctx, id);
    },
    async getPlatform(id) {
      return skills.filterAnyTenant((s) => s.id === id && s.scope === "platform")[0];
    },
    async findBySourceKey(ctx, sourceKey) {
      return skills.filter(ctx, (s) => s.sourceKey === sourceKey)[0];
    },
    async findByName(ctx, name) {
      return skills.filter(ctx, (s) => s.name === name).slice(0, 20);
    },
    async list(ctx, query = {}) {
      const status = query.status ?? "enabled";
      const term = query.q?.trim().toLowerCase();
      const scope = query.scope ?? "workspace";
      const own = (s: ExternalSkill) =>
        s.workspaceId === ctx.workspaceId && s.organizationId === ctx.organizationId;
      const where = (s: ExternalSkill) => {
        if (scope === "workspace" && !(own(s) && s.scope === "workspace")) return false;
        if (scope === "platform" && s.scope !== "platform") return false;
        if (scope === "visible" && !(own(s) && s.scope === "workspace") && s.scope !== "platform")
          return false;
        if (status !== "all" && s.status !== status) return false;
        if (query.owner !== undefined && s.source.owner.toLowerCase() !== query.owner.toLowerCase())
          return false;
        if (query.repo !== undefined && s.source.repo.toLowerCase() !== query.repo.toLowerCase())
          return false;
        return (
          !term ||
          s.name.toLowerCase().includes(term) ||
          s.description.toLowerCase().includes(term) ||
          s.sourceKey.includes(term)
        );
      };
      return listPage(skills.filterAnyTenant(where), query);
    },
    async getVersion(ctx, skillId, versionId) {
      const v = versions.get(ctx, versionId);
      return v?.skillId === skillId ? v : undefined;
    },
    async listVersions(ctx, skillId, query = {}) {
      return listPage(
        versions.filter(ctx, (v) => v.skillId === skillId),
        query,
      );
    },
    async findVersionByContentHash(ctx, skillId, contentHash) {
      return versions.filter(ctx, (v) => v.skillId === skillId && v.contentHash === contentHash)[0];
    },
    async findVersionByImportKey(ctx, importKey) {
      return versions.filter(ctx, (v) => v.importKey === importKey)[0];
    },
    async recordImport(ctx, input) {
      let skill = skills.filter(ctx, (s) => s.sourceKey === input.sourceKey)[0];
      const created = !skill;
      if (skill) {
        const same = versions.filter(
          ctx,
          (v) => v.skillId === skill!.id && v.contentHash === input.contentHash,
        )[0];
        if (same) return { outcome: "unchanged", skill, version: same };
      }
      if (input.importKey && versions.filter(ctx, (v) => v.importKey === input.importKey)[0]) {
        throw new StudixError("CONFLICT", "Import key already used");
      }
      skill ??= skills.insert(ctx, {
        id: input.skillId,
        sourceKey: input.sourceKey,
        source: input.source,
        scope: input.scope,
        name: input.name,
        description: input.description,
        status: input.initialStatus ?? "enabled",
        upstreamStatus: "current",
        createdBy: input.actor,
      });
      const version = versions.insert(ctx, {
        id: input.versionId,
        skillId: skill.id,
        commitSha: input.commitSha,
        contentHash: input.contentHash,
        name: input.name,
        description: input.description,
        manifest: input.manifest,
        storagePrefix: input.storagePrefix,
        importKey: input.importKey,
        risk: input.risk,
        createdBy: input.actor,
      });
      const activate = input.activate === true || skill.activeVersionId === undefined;
      skill = skills.update(ctx, skill.id, {
        upstreamStatus: "current",
        upstreamCheckedAt: clock.now(),
        ...(activate
          ? { activeVersionId: version.id, name: input.name, description: input.description }
          : {}),
      });
      await record(
        ctx,
        input.actor,
        created ? "external_skill.imported" : "external_skill.version_added",
        skill.id,
        {
          versionId: version.id,
          commitSha: input.commitSha,
          activated: activate,
          scope: skill.scope,
          riskLevel: input.risk.level,
        },
      );
      return { outcome: created ? "created" : "new_version", skill, version };
    },
    async activateVersion(ctx, skillId, versionId, actor, auditData) {
      requireSkill(ctx, skillId);
      const version = versions.get(ctx, versionId);
      if (version?.skillId !== skillId)
        throw new StudixError("NOT_FOUND", `Version ${versionId} not found for this skill`);
      const skill = skills.update(ctx, skillId, {
        activeVersionId: version.id,
        name: version.name,
        description: version.description,
      });
      await record(ctx, actor, "external_skill.version_activated", skillId, { versionId, ...auditData });
      return skill;
    },
    async setStatus(ctx, skillId, status, actor, auditData) {
      requireSkill(ctx, skillId);
      const skill = skills.update(ctx, skillId, {
        status,
        disabledAt: status === "disabled" ? clock.now() : undefined,
      });
      await record(
        ctx,
        actor,
        status === "disabled" ? "external_skill.disabled" : "external_skill.enabled",
        skillId,
        auditData,
      );
      return skill;
    },
    async delete(ctx, skillId, actor) {
      const skill = requireSkill(ctx, skillId);
      const own = versions.filter(ctx, (v) => v.skillId === skillId);
      for (const v of own) versions.delete(ctx, v.id);
      skills.delete(ctx, skillId);
      await record(ctx, actor, "external_skill.deleted", skillId, {
        sourceKey: skill.sourceKey,
        scope: skill.scope,
        versions: own.length,
      });
      return { storagePrefixes: own.map((v) => v.storagePrefix) };
    },
    async recordUpstreamCheck(ctx, skillId, status, actor) {
      requireSkill(ctx, skillId);
      const skill = skills.update(ctx, skillId, { upstreamStatus: status, upstreamCheckedAt: clock.now() });
      if (status === "removed" || status === "invalid") {
        await record(ctx, actor, "external_skill.upstream_flagged", skillId, { upstreamStatus: status });
      }
      return skill;
    },
  };
}
