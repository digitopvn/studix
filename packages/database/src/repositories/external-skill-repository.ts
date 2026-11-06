import type {
  ActorRef,
  ExternalSkill,
  ExternalSkillRepository,
  ExternalSkillVersion,
  RecordExternalSkillVersionInput,
  RecordExternalSkillVersionResult,
  TenantContext,
} from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
import type { DbExecutor } from "../client.ts";
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

type SkillRow = typeof externalSkills.$inferSelect;
type VersionRow = typeof externalSkillVersions.$inferSelect;

function toSkill(row: SkillRow): ExternalSkill {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    repository: row.repository,
    path: row.path,
    name: row.name,
    description: row.description,
    status: row.status,
    upstream: row.upstream,
    upstreamCheckedAt: opt(row.upstreamCheckedAt),
    activeVersionId: opt(row.activeVersionId),
    latestVersionId: opt(row.latestVersionId),
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    disabledAt: opt(row.disabledAt),
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
    importKey: opt(row.importKey),
    importedBy: actorFrom(row.importedByType, row.importedById),
    createdAt: row.createdAt,
  };
}

/** Escape LIKE wildcards so user text matches literally (Postgres' default LIKE escape is `\`). */
function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The manifest must describe the same source and capture the row is filed under. */
function assertConsistent(input: RecordExternalSkillVersionInput): void {
  const { manifest } = input;
  if (
    manifest.repository !== input.repository ||
    manifest.path !== input.path ||
    manifest.commitSha !== input.commitSha
  ) {
    throw new StudixError("VALIDATION", "skill manifest does not match the repository, path or commit", {
      details: { repository: input.repository, path: input.path, commitSha: input.commitSha },
    });
  }
}

export function createExternalSkillRepository(db: DbExecutor, clock: Clock): ExternalSkillRepository {
  const lockSkill = async (tx: DbExecutor, ctx: TenantContext, id: string) => {
    const rows = await tx
      .select()
      .from(externalSkills)
      .where(scoped(externalSkills, ctx, eq(externalSkills.id, id)))
      .for("update");
    return rows[0];
  };

  const findVersion = async (tx: DbExecutor, ctx: TenantContext, skillId: string, versionId: string) => {
    const rows = await tx
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
    return rows[0];
  };

  const audit = (
    tx: DbExecutor,
    ctx: TenantContext,
    actor: ActorRef,
    action: string,
    skillId: string,
    data: Record<string, unknown>,
  ) =>
    createAuditRepository(tx, clock).append(ctx, {
      actor,
      action,
      subjectType: "external_skill",
      subjectId: skillId,
      data,
    });

  const record = (ctx: TenantContext, input: RecordExternalSkillVersionInput) =>
    db.transaction(async (tx): Promise<RecordExternalSkillVersionResult> => {
      const now = clock.now();
      // Create the skill row if this source is new; a concurrent creator makes this a no-op, and the
      // row lock below then serialises every importer of the same source.
      await tx
        .insert(externalSkills)
        .values({
          id: newId("esk"),
          ...tenantValues(ctx),
          repository: input.repository,
          path: input.path,
          name: input.name,
          description: input.description,
          status: "enabled",
          upstream: "present",
          upstreamCheckedAt: now,
          createdByType: input.importedBy.type,
          createdById: input.importedBy.id,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [externalSkills.workspaceId, externalSkills.repository, externalSkills.path],
        });
      const locked = await tx
        .select()
        .from(externalSkills)
        .where(
          scoped(
            externalSkills,
            ctx,
            eq(externalSkills.repository, input.repository),
            eq(externalSkills.path, input.path),
          ),
        )
        .for("update");
      const skill = locked[0];
      if (!skill) {
        // Only reachable when the context names a workspace outside its organization.
        throw new StudixError("NOT_FOUND", "workspace not found for this organization");
      }

      const sameContent = scoped(
        externalSkillVersions,
        ctx,
        eq(externalSkillVersions.skillId, skill.id),
        eq(externalSkillVersions.commitSha, input.commitSha),
        eq(externalSkillVersions.contentHash, input.contentHash),
      );
      const existing = await tx.select().from(externalSkillVersions).where(sameContent).limit(1);
      if (existing[0])
        return { outcome: "unchanged", skill: toSkill(skill), version: toVersion(existing[0]) };

      const inserted = await tx
        .insert(externalSkillVersions)
        .values({
          id: newId("esv"),
          ...tenantValues(ctx),
          skillId: skill.id,
          commitSha: input.commitSha,
          contentHash: input.contentHash,
          name: input.name,
          description: input.description,
          manifest: input.manifest,
          importKey: input.importKey ?? null,
          importedByType: input.importedBy.type,
          importedById: input.importedBy.id,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [
            externalSkillVersions.skillId,
            externalSkillVersions.commitSha,
            externalSkillVersions.contentHash,
          ],
        })
        .returning();
      const version = inserted[0];
      if (!version) {
        // Unreachable while the skill row is locked; re-read rather than fail if it ever happens.
        const winner = await tx.select().from(externalSkillVersions).where(sameContent).limit(1);
        if (!winner[0]) throw new StudixError("CONFLICT", "skill import is changing concurrently; retry");
        return { outcome: "unchanged", skill: toSkill(skill), version: toVersion(winner[0]) };
      }

      // The first version becomes active; later ones only move `latest` until someone activates them.
      const becomesActive = skill.activeVersionId === null;
      const updated = await tx
        .update(externalSkills)
        .set({
          latestVersionId: version.id,
          upstream: "present",
          upstreamCheckedAt: now,
          updatedAt: now,
          ...(becomesActive
            ? { activeVersionId: version.id, name: version.name, description: version.description }
            : {}),
        })
        .where(eq(externalSkills.id, skill.id))
        .returning();
      const outcome = becomesActive ? "created" : "new_version";
      await audit(
        tx,
        ctx,
        input.importedBy,
        outcome === "created" ? "external_skill.imported" : "external_skill.version_added",
        skill.id,
        {
          repository: skill.repository,
          path: skill.path,
          commitSha: version.commitSha,
          versionId: version.id,
          ...(input.importKey === undefined ? {} : { importKey: input.importKey }),
        },
      );
      return { outcome, skill: toSkill(updated[0]!), version: toVersion(version) };
    });

  return {
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(externalSkills)
        .where(scoped(externalSkills, ctx, eq(externalSkills.id, id)))
        .limit(1);
      return rows[0] ? toSkill(rows[0]) : undefined;
    },

    async findBySource(ctx, repository, path) {
      const rows = await db
        .select()
        .from(externalSkills)
        .where(
          scoped(
            externalSkills,
            ctx,
            eq(externalSkills.repository, repository),
            eq(externalSkills.path, path),
          ),
        )
        .limit(1);
      return rows[0] ? toSkill(rows[0]) : undefined;
    },

    async findByName(ctx, name, limit) {
      const rows = await db
        .select()
        .from(externalSkills)
        .where(scoped(externalSkills, ctx, sql`lower(${externalSkills.name}) = lower(${name})`))
        .orderBy(desc(externalSkills.id))
        .limit(pageLimit(limit));
      return rows.map(toSkill);
    },

    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const q = query.q?.trim();
      const pattern = q ? likeContains(q) : undefined;
      const rows = await db
        .select()
        .from(externalSkills)
        .where(
          scoped(
            externalSkills,
            ctx,
            beforeCursor(externalSkills.id, query.cursor),
            query.status === undefined ? undefined : eq(externalSkills.status, query.status),
            query.repository === undefined ? undefined : eq(externalSkills.repository, query.repository),
            pattern === undefined
              ? undefined
              : or(
                  ilike(externalSkills.name, pattern),
                  ilike(externalSkills.description, pattern),
                  ilike(externalSkills.repository, pattern),
                ),
          ),
        )
        .orderBy(desc(externalSkills.id))
        .limit(limit + 1);
      return toPage(rows.map(toSkill), limit);
    },

    async getVersion(ctx, skillId, versionId) {
      const row = await findVersion(db, ctx, skillId, versionId);
      return row ? toVersion(row) : undefined;
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

    async recordVersion(ctx, input) {
      assertConsistent(input);
      try {
        return await record(ctx, input);
      } catch (err) {
        // The skill and version inserts resolve conflicts in place, so a unique violation here means a
        // concurrent writer slipped between statements; one retry observes its committed result.
        if (!isUniqueViolation(err)) throw err;
        return record(ctx, input);
      }
    },

    async activateVersion(ctx, skillId, versionId, actor) {
      return db.transaction(async (tx) => {
        const skill = await lockSkill(tx, ctx, skillId);
        if (!skill) return undefined;
        const version = await findVersion(tx, ctx, skillId, versionId);
        if (!version) return undefined;
        if (skill.activeVersionId === version.id) return toSkill(skill);
        const updated = await tx
          .update(externalSkills)
          .set({
            activeVersionId: version.id,
            name: version.name,
            description: version.description,
            updatedAt: clock.now(),
          })
          .where(eq(externalSkills.id, skill.id))
          .returning();
        await audit(tx, ctx, actor, "external_skill.version_activated", skill.id, {
          repository: skill.repository,
          path: skill.path,
          commitSha: version.commitSha,
          versionId: version.id,
          previousVersionId: skill.activeVersionId,
        });
        return toSkill(updated[0]!);
      });
    },

    async setStatus(ctx, skillId, status, actor) {
      return db.transaction(async (tx) => {
        const skill = await lockSkill(tx, ctx, skillId);
        if (!skill) return undefined;
        if (skill.status === status) return toSkill(skill);
        const now = clock.now();
        const updated = await tx
          .update(externalSkills)
          .set({ status, disabledAt: status === "disabled" ? now : null, updatedAt: now })
          .where(eq(externalSkills.id, skill.id))
          .returning();
        await audit(
          tx,
          ctx,
          actor,
          status === "disabled" ? "external_skill.disabled" : "external_skill.enabled",
          skill.id,
          { repository: skill.repository, path: skill.path },
        );
        return toSkill(updated[0]!);
      });
    },

    async markUpstream(ctx, skillId, upstream, actor) {
      return db.transaction(async (tx) => {
        const skill = await lockSkill(tx, ctx, skillId);
        if (!skill) return undefined;
        const now = clock.now();
        const changed = skill.upstream !== upstream;
        const updated = await tx
          .update(externalSkills)
          .set({ upstream, upstreamCheckedAt: now, ...(changed ? { updatedAt: now } : {}) })
          .where(eq(externalSkills.id, skill.id))
          .returning();
        if (changed) {
          await audit(
            tx,
            ctx,
            actor,
            upstream === "missing" ? "external_skill.upstream_missing" : "external_skill.upstream_present",
            skill.id,
            { repository: skill.repository, path: skill.path },
          );
        }
        return toSkill(updated[0]!);
      });
    },
  };
}
