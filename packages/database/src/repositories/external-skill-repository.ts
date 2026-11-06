import type {
  ExternalSkill,
  ExternalSkillRepository,
  ExternalSkillVersion,
  RecordExternalSkillOutcome,
} from "@studix/core";
import type { Clock } from "@studix/shared";
import { newId } from "@studix/shared";
import { desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import type { DbExecutor } from "../client.ts";
import { externalSkills, externalSkillVersions } from "../schema/external-skills.ts";
import { actorFrom, beforeCursor, opt, pageLimit, scoped, tenantValues, toPage } from "./helpers.ts";

function toSkill(row: typeof externalSkills.$inferSelect): ExternalSkill {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    sourceKey: row.sourceKey,
    source: row.source,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    activeVersionId: opt(row.activeVersionId),
    latestVersionId: row.latestVersionId,
    upstreamStatus: row.upstreamStatus,
    upstreamCheckedAt: opt(row.upstreamCheckedAt),
    createdBy: actorFrom(row.createdByType, row.createdById),
    disabledAt: opt(row.disabledAt),
    disabledBy:
      row.disabledByType && row.disabledById ? actorFrom(row.disabledByType, row.disabledById) : undefined,
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
    version: row.version,
    commitSha: row.commitSha,
    ref: opt(row.ref),
    contentHash: row.contentHash,
    name: row.name,
    description: row.description,
    manifest: row.manifest,
    importedBy: actorFrom(row.importedByType, row.importedById),
    createdAt: row.createdAt,
  };
}

/** `%` and `_` in user text must match themselves, not act as wildcards. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function createExternalSkillRepository(db: DbExecutor, clock: Clock): ExternalSkillRepository {
  const findSkill = async (ctx: Parameters<ExternalSkillRepository["get"]>[0], id: string) => {
    const rows = await db
      .select()
      .from(externalSkills)
      .where(scoped(externalSkills, ctx, eq(externalSkills.id, id)))
      .limit(1);
    return rows[0] ? toSkill(rows[0]) : undefined;
  };

  return {
    async recordVersion(ctx, input) {
      // One import of a source at a time per workspace: the lock makes "find, then create" race-free, and the
      // unique indexes on source and content stay as the backstop if a lock is ever bypassed.
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`external-skill:${ctx.workspaceId}:${input.sourceKey}`}, 0))`,
        );
        const now = clock.now();
        const existingRows = await tx
          .select()
          .from(externalSkills)
          .where(scoped(externalSkills, ctx, eq(externalSkills.sourceKey, input.sourceKey)))
          .limit(1);
        let skill = existingRows[0];

        if (skill) {
          const same = await tx
            .select()
            .from(externalSkillVersions)
            .where(
              scoped(
                externalSkillVersions,
                ctx,
                eq(externalSkillVersions.skillId, skill.id),
                eq(externalSkillVersions.contentHash, input.contentHash),
              ),
            )
            .limit(1);
          if (same[0]) {
            return { skill: toSkill(skill), version: toVersion(same[0]), outcome: "unchanged" as const };
          }
        }

        const created = skill === undefined;
        const skillId = skill?.id ?? newId("xsk");
        const versionId = newId("xsv");
        if (!skill) {
          const rows = await tx
            .insert(externalSkills)
            .values({
              id: skillId,
              ...tenantValues(ctx),
              sourceKey: input.sourceKey,
              source: input.source,
              name: input.name,
              description: input.description,
              enabled: true,
              latestVersionId: versionId,
              upstreamStatus: "current",
              createdByType: input.importedBy.type,
              createdById: input.importedBy.id,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          skill = rows[0];
        }
        if (!skill) throw new Error("external skill insert returned no row");

        // The advisory lock above serializes writers of this source, so the next number cannot be taken.
        const [{ next }] = (await tx
          .select({ next: sql<number>`coalesce(max(${externalSkillVersions.version}), 0) + 1` })
          .from(externalSkillVersions)
          .where(eq(externalSkillVersions.skillId, skillId))) as [{ next: number }];
        const versionRow = (
          await tx
            .insert(externalSkillVersions)
            .values({
              id: versionId,
              ...tenantValues(ctx),
              skillId,
              version: Number(next),
              commitSha: input.commitSha,
              ref: input.ref ?? null,
              contentHash: input.contentHash,
              name: input.name,
              description: input.description,
              manifest: input.manifest,
              importedByType: input.importedBy.type,
              importedById: input.importedBy.id,
              createdAt: now,
            })
            .returning()
        )[0];
        if (!versionRow) throw new Error("external skill version insert returned no row");

        const activate = input.activate || created || skill.activeVersionId === null;
        const updated = await tx
          .update(externalSkills)
          .set({
            latestVersionId: versionRow.id,
            upstreamStatus: "current",
            upstreamCheckedAt: now,
            updatedAt: now,
            ...(activate
              ? { activeVersionId: versionRow.id, name: input.name, description: input.description }
              : {}),
          })
          .where(eq(externalSkills.id, skillId))
          .returning();
        const outcome: RecordExternalSkillOutcome = created ? "created" : "new_version";
        return { skill: toSkill(updated[0] ?? skill), version: toVersion(versionRow), outcome };
      });
    },

    async get(ctx, id) {
      return findSkill(ctx, id);
    },

    async findBySourceKey(ctx, sourceKey) {
      const rows = await db
        .select()
        .from(externalSkills)
        .where(scoped(externalSkills, ctx, eq(externalSkills.sourceKey, sourceKey)))
        .limit(1);
      return rows[0] ? toSkill(rows[0]) : undefined;
    },

    async findByName(ctx, name, exceptId) {
      const rows = await db
        .select()
        .from(externalSkills)
        .where(
          scoped(
            externalSkills,
            ctx,
            eq(externalSkills.name, name),
            exceptId === undefined ? undefined : ne(externalSkills.id, exceptId),
          ),
        )
        .orderBy(desc(externalSkills.id))
        .limit(20);
      return rows.map(toSkill);
    },

    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const pattern = query.query ? likePattern(query.query) : undefined;
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
              : sql`lower((${externalSkills.source}->>'owner') || '/' || (${externalSkills.source}->>'repo')) = ${query.repository.toLowerCase()}`,
            pattern === undefined
              ? undefined
              : or(ilike(externalSkills.name, pattern), ilike(externalSkills.description, pattern)),
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

    async activateVersion(ctx, skillId, versionId) {
      const version = await this.getVersion(ctx, skillId, versionId);
      if (!version) return undefined;
      const rows = await db
        .update(externalSkills)
        .set({
          activeVersionId: version.id,
          name: version.name,
          description: version.description,
          updatedAt: clock.now(),
        })
        .where(scoped(externalSkills, ctx, eq(externalSkills.id, skillId)))
        .returning();
      return rows[0] ? toSkill(rows[0]) : undefined;
    },

    async setEnabled(ctx, skillId, enabled, by) {
      const now = clock.now();
      const rows = await db
        .update(externalSkills)
        .set(
          enabled
            ? { enabled: true, disabledAt: null, disabledByType: null, disabledById: null, updatedAt: now }
            : {
                enabled: false,
                disabledAt: now,
                disabledByType: by.type,
                disabledById: by.id,
                updatedAt: now,
              },
        )
        .where(scoped(externalSkills, ctx, eq(externalSkills.id, skillId)))
        .returning();
      return rows[0] ? toSkill(rows[0]) : undefined;
    },

    async setUpstreamStatus(ctx, skillId, status) {
      const now = clock.now();
      const rows = await db
        .update(externalSkills)
        .set({ upstreamStatus: status, upstreamCheckedAt: now, updatedAt: now })
        .where(scoped(externalSkills, ctx, eq(externalSkills.id, skillId)))
        .returning();
      return rows[0] ? toSkill(rows[0]) : undefined;
    },
  };
}
