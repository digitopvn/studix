import type {
  ExternalSkill,
  ExternalSkillRepository,
  ExternalSkillVersion,
  ImportVersionResult,
  TenantContext,
} from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { desc, eq, ilike, or } from "drizzle-orm";
import type { DbExecutor } from "../client.ts";
import { externalSkills, externalSkillVersions } from "../schema/external-skills.ts";
import { actorFrom, beforeCursor, opt, pageLimit, scoped, tenantValues, toPage } from "./helpers.ts";

type SkillRow = typeof externalSkills.$inferSelect;
type VersionRow = typeof externalSkillVersions.$inferSelect;

function toSkill(row: SkillRow): ExternalSkill {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    repository: row.repository,
    skillPath: row.skillPath,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    activeVersionId: opt(row.activeVersionId),
    upstreamStatus: row.upstreamStatus,
    upstreamCheckedAt: opt(row.upstreamCheckedAt),
    upstreamCommitSha: opt(row.upstreamCommitSha),
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersion(row: VersionRow): ExternalSkillVersion {
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
    skillStorageKey: row.skillStorageKey,
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
  };
}

/** Escape LIKE metacharacters so user text matches literally (backslash is Postgres' default escape). */
function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function createExternalSkillRepository(db: DbExecutor, clock: Clock): ExternalSkillRepository {
  const skillWhere = (ctx: TenantContext, skillId: string) =>
    scoped(externalSkills, ctx, eq(externalSkills.id, skillId));

  const updateSkill = async (
    ctx: TenantContext,
    skillId: string,
    patch: Partial<Omit<SkillRow, "id" | "organizationId" | "workspaceId" | "createdAt">>,
    executor: DbExecutor = db,
  ): Promise<ExternalSkill | undefined> => {
    const rows = await executor
      .update(externalSkills)
      .set({ ...patch, updatedAt: clock.now() })
      .where(skillWhere(ctx, skillId))
      .returning();
    return rows[0] ? toSkill(rows[0]) : undefined;
  };

  return {
    async get(ctx, skillId) {
      const rows = await db.select().from(externalSkills).where(skillWhere(ctx, skillId)).limit(1);
      return rows[0] ? toSkill(rows[0]) : undefined;
    },

    async findBySource(ctx, repository, skillPath) {
      const rows = await db
        .select()
        .from(externalSkills)
        .where(
          scoped(
            externalSkills,
            ctx,
            eq(externalSkills.repository, repository.toLowerCase()),
            eq(externalSkills.skillPath, skillPath),
          ),
        )
        .limit(1);
      return rows[0] ? toSkill(rows[0]) : undefined;
    },

    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const text = query.query?.trim();
      const pattern = text ? `%${escapeLikePattern(text)}%` : undefined;
      const rows = await db
        .select()
        .from(externalSkills)
        .where(
          scoped(
            externalSkills,
            ctx,
            query.enabled === undefined ? undefined : eq(externalSkills.enabled, query.enabled),
            query.repository === undefined
              ? undefined
              : eq(externalSkills.repository, query.repository.toLowerCase()),
            pattern === undefined
              ? undefined
              : or(
                  ilike(externalSkills.name, pattern),
                  ilike(externalSkills.description, pattern),
                  ilike(externalSkills.repository, pattern),
                ),
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

    async importVersion(ctx, input) {
      const repository = input.repository.toLowerCase();
      const run = async (tx: DbExecutor): Promise<ImportVersionResult> => {
        const now = clock.now();
        // A concurrent first import blocks here on the uncommitted unique key and then sees its row.
        const inserted = await tx
          .insert(externalSkills)
          .values({
            id: input.skillId ?? newId("xsk"),
            ...tenantValues(ctx),
            repository,
            skillPath: input.skillPath,
            name: input.name,
            description: input.description,
            createdByType: input.createdBy.type,
            createdById: input.createdBy.id,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [
              externalSkills.organizationId,
              externalSkills.workspaceId,
              externalSkills.repository,
              externalSkills.skillPath,
            ],
          })
          .returning({ id: externalSkills.id });
        // The row lock serializes every import of this skill, so only one can claim the first activation.
        const locked = await tx
          .select()
          .from(externalSkills)
          .where(
            scoped(
              externalSkills,
              ctx,
              eq(externalSkills.repository, repository),
              eq(externalSkills.skillPath, input.skillPath),
            ),
          )
          .for("update");
        const skillRow = locked[0];
        if (!skillRow)
          throw new StudixError(
            "INTERNAL",
            `external skill ${repository}/${input.skillPath} vanished during import`,
          );
        const skillCreated = inserted.length > 0;

        const created = await tx
          .insert(externalSkillVersions)
          .values({
            id: input.versionId ?? newId("xsv"),
            ...tenantValues(ctx),
            skillId: skillRow.id,
            commitSha: input.commitSha,
            contentHash: input.contentHash,
            name: input.name,
            description: input.description,
            manifest: input.manifest,
            skillStorageKey: input.skillStorageKey,
            createdByType: input.createdBy.type,
            createdById: input.createdBy.id,
            createdAt: now,
          })
          .onConflictDoNothing({ target: [externalSkillVersions.skillId, externalSkillVersions.contentHash] })
          .returning();

        if (!created[0]) {
          const existing = await tx
            .select()
            .from(externalSkillVersions)
            .where(
              scoped(
                externalSkillVersions,
                ctx,
                eq(externalSkillVersions.skillId, skillRow.id),
                eq(externalSkillVersions.contentHash, input.contentHash),
              ),
            )
            .limit(1);
          if (!existing[0])
            throw new StudixError(
              "INTERNAL",
              `external skill version ${input.contentHash} conflicted without a row`,
            );
          return {
            skill: toSkill(skillRow),
            version: toVersion(existing[0]),
            outcome: "unchanged",
            skillCreated,
            activated: false,
          };
        }

        const version = toVersion(created[0]);
        if (skillRow.activeVersionId !== null) {
          return { skill: toSkill(skillRow), version, outcome: "created", skillCreated, activated: false };
        }
        const activated = await updateSkill(
          ctx,
          skillRow.id,
          { activeVersionId: version.id, name: version.name, description: version.description },
          tx,
        );
        if (!activated)
          throw new StudixError("INTERNAL", `external skill ${skillRow.id} vanished during import`);
        return { skill: activated, version, outcome: "created", skillCreated, activated: true };
      };
      return db.transaction(run);
    },

    async activateVersion(ctx, skillId, versionId) {
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
      const version = rows[0];
      if (!version) return undefined;
      // Versions are immutable, so copying from the row read above cannot race with a change to it.
      return updateSkill(ctx, skillId, {
        activeVersionId: version.id,
        name: version.name,
        description: version.description,
      });
    },

    async setEnabled(ctx, skillId, enabled) {
      return updateSkill(ctx, skillId, { enabled });
    },

    async recordUpstreamCheck(ctx, skillId, check) {
      return updateSkill(ctx, skillId, {
        upstreamStatus: check.status,
        upstreamCheckedAt: check.checkedAt,
        upstreamCommitSha: check.commitSha ?? null,
      });
    },
  };
}
