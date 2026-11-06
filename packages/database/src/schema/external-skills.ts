import type { ExternalSkillManifest, UpstreamStatus } from "@studix/core";
import { boolean, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, ts, updatedAt } from "./columns.ts";
import { tenantColumns } from "./tenancy.ts";

/**
 * Skills imported from public GitHub repositories, one row per (repository, skill directory) of a
 * workspace. Name and description mirror the active version. `active_version_id` is plain text rather
 * than a foreign key: versions are only ever removed together with their skill (cascade), and a key in
 * both directions would make inserting the first version a circular dependency.
 */
export const externalSkills = pgTable(
  "external_skills",
  {
    id: id(),
    ...tenantColumns(),
    repository: text("repository").notNull(),
    skillPath: text("skill_path").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    activeVersionId: text("active_version_id"),
    upstreamStatus: text("upstream_status").$type<UpstreamStatus>().notNull().default("unknown"),
    upstreamCheckedAt: ts("upstream_checked_at"),
    upstreamCommitSha: text("upstream_commit_sha"),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("external_skills_source_uq").on(t.organizationId, t.workspaceId, t.repository, t.skillPath),
    index("external_skills_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
  ],
);

/** Immutable versions of a skill; the content hash makes re-importing the same content idempotent. */
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
    skillStorageKey: text("skill_storage_key").notNull(),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("external_skill_versions_content_uq").on(t.skillId, t.contentHash),
    index("external_skill_versions_skill_idx").on(t.skillId, t.id),
  ],
);
