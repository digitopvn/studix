import type { ExternalSkillManifest, ExternalSkillStatus, ExternalSkillUpstream } from "@studix/core";
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, ts, updatedAt } from "./columns.ts";
import { tenantColumns } from "./tenancy.ts";

/**
 * Agent Skills imported from a public GitHub repository, one row per (workspace, repository, path).
 * `active_version_id` and `latest_version_id` point into `external_skill_versions` but carry no foreign
 * key (the version rows reference the skill, so a key back would form a cycle); the repository only ever
 * writes ids of versions it has just read or inserted for the same skill and tenant.
 */
export const externalSkills = pgTable(
  "external_skills",
  {
    id: id(),
    ...tenantColumns(),
    repository: text("repository").notNull(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    status: text("status").$type<ExternalSkillStatus>().notNull().default("enabled"),
    upstream: text("upstream").$type<ExternalSkillUpstream>().notNull().default("present"),
    upstreamCheckedAt: ts("upstream_checked_at"),
    activeVersionId: text("active_version_id"),
    latestVersionId: text("latest_version_id"),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    disabledAt: ts("disabled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("external_skills_source_uq").on(t.workspaceId, t.repository, t.path),
    index("external_skills_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
    index("external_skills_name_idx").on(t.workspaceId, sql`lower(${t.name})`),
  ],
);

/** Immutable captures of one skill: rows are inserted by an import and never updated or deleted. */
export const externalSkillVersions = pgTable(
  "external_skill_versions",
  {
    id: id(),
    ...tenantColumns(),
    skillId: text("skill_id")
      .notNull()
      .references(() => externalSkills.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    contentHash: text("content_hash").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    manifest: jsonb("manifest").$type<ExternalSkillManifest>().notNull(),
    importKey: text("import_key"),
    importedByType: text("imported_by_type").$type<ActorType>().notNull(),
    importedById: text("imported_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("external_skill_versions_content_uq").on(t.skillId, t.commitSha, t.contentHash),
    index("external_skill_versions_skill_idx").on(t.skillId, t.id),
  ],
);
