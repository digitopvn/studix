import type { ExternalSkillManifest, ExternalSkillSource, ExternalSkillUpstreamStatus } from "@studix/core";
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, ts, updatedAt } from "./columns.ts";
import { tenantColumns } from "./tenancy.ts";

/**
 * Agent Skills imported from public GitHub repositories into one workspace. A row names the source and
 * tracks which immutable version is in use; the content lives in `external_skill_versions` and object storage.
 * Separate from the built-in workflow and knowledge packs, which stay in code.
 */
export const externalSkills = pgTable(
  "external_skills",
  {
    id: id(),
    ...tenantColumns(),
    /** Lower-cased `github.com/<owner>/<repo>:<path>`. */
    sourceKey: text("source_key").notNull(),
    source: jsonb("source").$type<ExternalSkillSource>().notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    activeVersionId: text("active_version_id"),
    latestVersionId: text("latest_version_id").notNull(),
    upstreamStatus: text("upstream_status").$type<ExternalSkillUpstreamStatus>().notNull().default("unknown"),
    upstreamCheckedAt: ts("upstream_checked_at"),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    disabledAt: ts("disabled_at"),
    disabledByType: text("disabled_by_type").$type<ActorType>(),
    disabledById: text("disabled_by_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("external_skills_source_uq").on(t.organizationId, t.workspaceId, t.sourceKey),
    index("external_skills_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
    index("external_skills_name_idx").on(t.workspaceId, t.organizationId, t.name),
  ],
);

/** One immutable import of a skill at a pinned commit; never updated after insert. */
export const externalSkillVersions = pgTable(
  "external_skill_versions",
  {
    id: id(),
    ...tenantColumns(),
    skillId: text("skill_id")
      .notNull()
      .references(() => externalSkills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    commitSha: text("commit_sha").notNull(),
    ref: text("ref"),
    contentHash: text("content_hash").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    manifest: jsonb("manifest").$type<ExternalSkillManifest>().notNull(),
    importedByType: text("imported_by_type").$type<ActorType>().notNull(),
    importedById: text("imported_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("external_skill_versions_number_uq").on(t.skillId, t.version),
    uniqueIndex("external_skill_versions_content_uq").on(t.skillId, t.contentHash),
    index("external_skill_versions_tenant_idx").on(t.workspaceId, t.organizationId, t.skillId, t.id),
  ],
);
