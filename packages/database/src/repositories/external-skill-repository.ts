import type {
  ExternalSkill,
  ExternalSkillRepository,
  ExternalSkillVersion,
  TenantContext,
} from "@studix/core";
import { type Clock, StudixError } from "@studix/shared";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { DbExecutor, StudixDb } from "../client.ts";
import { externalSkills, externalSkillVersions } from "../schema/external-skills.ts";
import { createAuditRepository } from "./governance-repositories.ts";
import {
  actorFrom,
  beforeCursor,
  isUniqueViolation,
  opt,
  pageLimit,
  scoped,
  tenantValues,
  toPage,
} from "./helpers.ts";

function toSkill(row: typeof externalSkills.$inferSelect): ExternalSkill {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    sourceKey: row.sourceKey,
    source: row.source,
    name: row.name,
    description: row.description,
    status: row.status,
    activeVersionId: opt(row.activeVersionId),
    upstreamStatus: row.upstreamStatus,
    upstreamCheckedAt: opt(row.upstreamCheckedAt),
    createdBy: actorFrom(row.createdByType, row.createdById),
    disabledAt: opt(row.disabledAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersion(row: typeof externalSkillVersions.$inferSelect): ExternalSkillVersion {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    skillId: row.skillId,
    commitSha: row.commitSha,
    contentHash: row.contentHash,
    name: row.name,
    description: row.description,
    manifest: row.manifest,
    storagePrefix: row.storagePrefix,
    importKey: opt(row.importKey),
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
  };
}

/** Escape LIKE wildcards so a search term matches literally. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function createExternalSkillRepository(db: StudixDb, clock: Clock): ExternalSkillRepository {
  const requireSkill = async (ctx: TenantContext, skillId: string) => {
    const rows = await db
      .select()
      .from(externalSkills)
      .where(scoped(externalSkills, ctx, eq(externalSkills.id, skillId)))
      .limit(1);
    if (!rows[0]) throw new StudixError("NOT_FOUND", `Skill ${skillId} not found`);
    return rows[0];
  };

  return {
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(externalSkills)
        .where(scoped(externalSkills, ctx, eq(externalSkills.id, id)))
        .limit(1);
      return rows[0] ? toSkill(rows[0]) : undefined;
    },

    async findBySourceKey(ctx, sourceKey) {
      const rows = await db
        .select()
        .from(externalSkills)
        .where(scoped(externalSkills, ctx, eq(externalSkills.sourceKey, sourceKey)))
        .limit(1);
      return rows[0] ? toSkill(rows[0]) : undefined;
    },

    async findByName(ctx, name) {
      const rows = await db
        .select()
        .from(externalSkills)
        .where(scoped(externalSkills, ctx, eq(externalSkills.name, name)))
        .orderBy(desc(externalSkills.id))
        .limit(20);
      return rows.map(toSkill);
    },

    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const status = query.status ?? "enabled";
      const term = query.q?.trim();
      const rows = await db
        .select()
        .from(externalSkills)
        .where(
          scoped(
            externalSkills,
            ctx,
            status === "all" ? undefined : eq(externalSkills.status, status),
            query.owner === undefined
              ? undefined
              : sql`lower(${externalSkills.source}->>'owner') = ${query.owner.toLowerCase()}`,
            query.repo === undefined
              ? undefined
              : sql`lower(${externalSkills.source}->>'repo') = ${query.repo.toLowerCase()}`,
            term
              ? or(
                  ilike(externalSkills.name, likePattern(term)),
                  ilike(externalSkills.description, likePattern(term)),
                  ilike(externalSkills.sourceKey, likePattern(term)),
                )
              : undefined,
            beforeCursor(externalSkills.id, query.cursor),
          ),
        )
        .orderBy(desc(externalSkills.id))
        .limit(limit + 1);
      return toPage(rows.map(toSkill), limit);
    },

    async getVersion(ctx, skillId, versionId) {
      const rows = await db
        .select()
        .from(externalSkillVersions)
        .where(
          scoped(
            externalSkillVersions,
            ctx,
            eq(externalSkillVersions.skillId, skillId),
            eq(externalSkillVersions.id, versionId),
          ),
        )
        .limit(1);
      return rows[0] ? toVersion(rows[0]) : undefined;
    },

    async listVersions(ctx, skillId, query = {}) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(externalSkillVersions)
        .where(
          scoped(
            externalSkillVersions,
            ctx,
            eq(externalSkillVersions.skillId, skillId),
            beforeCursor(externalSkillVersions.id, query.cursor),
          ),
        )
        .orderBy(desc(externalSkillVersions.id))
        .limit(limit + 1);
      return toPage(rows.map(toVersion), limit);
    },

    async findVersionByContentHash(ctx, skillId, contentHash) {
      const rows = await db
        .select()
        .from(externalSkillVersions)
        .where(
          scoped(
            externalSkillVersions,
            ctx,
            eq(externalSkillVersions.skillId, skillId),
            eq(externalSkillVersions.contentHash, contentHash),
          ),
        )
        .limit(1);
      return rows[0] ? toVersion(rows[0]) : undefined;
    },

    async findVersionByImportKey(ctx, importKey) {
      const rows = await db
        .select()
        .from(externalSkillVersions)
        .where(scoped(externalSkillVersions, ctx, eq(externalSkillVersions.importKey, importKey)))
        .limit(1);
      return rows[0] ? toVersion(rows[0]) : undefined;
    },

    async recordImport(ctx, input) {
      const now = clock.now();
      const run = () =>
        db.transaction(async (tx) => {
          // The unique source index makes concurrent first imports of one source meet here.
          await tx
            .insert(externalSkills)
            .values({
              id: input.skillId,
              ...tenantValues(ctx),
              sourceKey: input.sourceKey,
              source: input.source,
              name: input.name,
              description: input.description,
              status: "enabled",
              upstreamStatus: "current",
              upstreamCheckedAt: now,
              createdByType: input.actor.type,
              createdById: input.actor.id,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: [externalSkills.workspaceId, externalSkills.sourceKey] });
          // Row lock: imports of one source run one after another from here to commit.
          const locked = await tx
            .select()
            .from(externalSkills)
            .where(scoped(externalSkills, ctx, eq(externalSkills.sourceKey, input.sourceKey)))
            .for("update");
          const skillRow = locked[0];
          if (!skillRow) throw new StudixError("INTERNAL", "Skill row missing after upsert");
          const created = skillRow.id === input.skillId;

          const existing = await tx
            .select()
            .from(externalSkillVersions)
            .where(
              and(
                eq(externalSkillVersions.skillId, skillRow.id),
                eq(externalSkillVersions.contentHash, input.contentHash),
              ),
            )
            .limit(1);
          if (existing[0]) {
            return {
              outcome: "unchanged" as const,
              skill: toSkill(skillRow),
              version: toVersion(existing[0]),
            };
          }

          const inserted = await tx
            .insert(externalSkillVersions)
            .values({
              id: input.versionId,
              ...tenantValues(ctx),
              skillId: skillRow.id,
              commitSha: input.commitSha,
              contentHash: input.contentHash,
              name: input.name,
              description: input.description,
              manifest: input.manifest,
              storagePrefix: input.storagePrefix,
              importKey: input.importKey ?? null,
              createdByType: input.actor.type,
              createdById: input.actor.id,
              createdAt: now,
            })
            .returning();
          const activate = input.activate === true || skillRow.activeVersionId === null;
          const updated = await tx
            .update(externalSkills)
            .set({
              upstreamStatus: "current",
              upstreamCheckedAt: now,
              updatedAt: now,
              ...(activate
                ? { activeVersionId: input.versionId, name: input.name, description: input.description }
                : {}),
            })
            .where(eq(externalSkills.id, skillRow.id))
            .returning();
          await createAuditRepository(tx, clock).append(ctx, {
            actor: input.actor,
            action: created ? "external_skill.imported" : "external_skill.version_added",
            subjectType: "external_skill",
            subjectId: skillRow.id,
            data: {
              versionId: input.versionId,
              sourceKey: input.sourceKey,
              commitSha: input.commitSha,
              contentHash: input.contentHash,
              activated: activate,
              ...(input.importKey ? { importKey: input.importKey } : {}),
            },
          });
          return {
            outcome: created ? ("created" as const) : ("new_version" as const),
            skill: toSkill(updated[0]!),
            version: toVersion(inserted[0]!),
          };
        });
      try {
        return await run();
      } catch (err) {
        // A replay of the same idempotency key from another request got there first.
        if (!isUniqueViolation(err) || input.importKey === undefined) throw err;
        const rows = await db
          .select()
          .from(externalSkillVersions)
          .where(scoped(externalSkillVersions, ctx, eq(externalSkillVersions.importKey, input.importKey)))
          .limit(1);
        const skillRows = rows[0]
          ? await db
              .select()
              .from(externalSkills)
              .where(scoped(externalSkills, ctx, eq(externalSkills.id, rows[0].skillId)))
              .limit(1)
          : [];
        if (!rows[0] || !skillRows[0]) throw err;
        if (skillRows[0].sourceKey !== input.sourceKey) {
          throw new StudixError("CONFLICT", "The idempotency key was already used for a different skill");
        }
        return { outcome: "unchanged" as const, skill: toSkill(skillRows[0]), version: toVersion(rows[0]) };
      }
    },

    async activateVersion(ctx, skillId, versionId, actor) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(externalSkills)
          .where(scoped(externalSkills, ctx, eq(externalSkills.id, skillId)))
          .for("update");
        if (!rows[0]) throw new StudixError("NOT_FOUND", `Skill ${skillId} not found`);
        const versions = await tx
          .select()
          .from(externalSkillVersions)
          .where(and(eq(externalSkillVersions.skillId, skillId), eq(externalSkillVersions.id, versionId)))
          .limit(1);
        const version = versions[0];
        if (!version) throw new StudixError("NOT_FOUND", `Version ${versionId} not found for this skill`);
        const updated = await tx
          .update(externalSkills)
          .set({
            activeVersionId: version.id,
            name: version.name,
            description: version.description,
            updatedAt: clock.now(),
          })
          .where(eq(externalSkills.id, skillId))
          .returning();
        await createAuditRepository(tx, clock).append(ctx, {
          actor,
          action: "external_skill.version_activated",
          subjectType: "external_skill",
          subjectId: skillId,
          data: { versionId, previousVersionId: rows[0].activeVersionId },
        });
        return toSkill(updated[0]!);
      });
    },

    async setStatus(ctx, skillId, status, actor) {
      return db.transaction(async (tx) => {
        await requireSkillIn(tx, ctx, skillId);
        const now = clock.now();
        const updated = await tx
          .update(externalSkills)
          .set({ status, disabledAt: status === "disabled" ? now : null, updatedAt: now })
          .where(scoped(externalSkills, ctx, eq(externalSkills.id, skillId)))
          .returning();
        await createAuditRepository(tx, clock).append(ctx, {
          actor,
          action: status === "disabled" ? "external_skill.disabled" : "external_skill.enabled",
          subjectType: "external_skill",
          subjectId: skillId,
        });
        return toSkill(updated[0]!);
      });
    },

    async recordUpstreamCheck(ctx, skillId, status, actor) {
      await requireSkill(ctx, skillId);
      const now = clock.now();
      const updated = await db
        .update(externalSkills)
        .set({ upstreamStatus: status, upstreamCheckedAt: now, updatedAt: now })
        .where(scoped(externalSkills, ctx, eq(externalSkills.id, skillId)))
        .returning();
      // A check is read-mostly; only a finding that needs attention is worth an audit event.
      if (status === "removed" || status === "invalid") {
        await createAuditRepository(db, clock).append(ctx, {
          actor,
          action: "external_skill.upstream_flagged",
          subjectType: "external_skill",
          subjectId: skillId,
          data: { upstreamStatus: status },
        });
      }
      return toSkill(updated[0]!);
    },
  };
}

async function requireSkillIn(tx: DbExecutor, ctx: TenantContext, skillId: string) {
  const rows = await tx
    .select({ id: externalSkills.id })
    .from(externalSkills)
    .where(scoped(externalSkills, ctx, eq(externalSkills.id, skillId)))
    .for("update");
  if (!rows[0]) throw new StudixError("NOT_FOUND", `Skill ${skillId} not found`);
}
