import type {
  ExternalSkillManifest,
  ExternalSkillScope,
  ExternalSkillSource,
  ExternalSkillStatus,
  ExternalSkillUpstreamStatus,
  SkillRiskReport,
} from "@studix/core";
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, ts, updatedAt } from "./columns.ts";
import { tenantColumns } from "./tenancy.ts";

/**
 * Agent Skills imported from public GitHub repositories or uploaded as zip archives. One row per (workspace,
 * source); the content lives in immutable versions with every file stored in full. Kept apart from workflow
 * and knowledge packs on purpose: their scripts run only in the skill sandbox, never in Studix itself.
 * `platform` rows live in the operator's workspace and are visible to every workspace.
 */
export const externalSkills = pgTable(
  "external_skills",
  {
    id: id(),
    ...tenantColumns(),
    sourceKey: text("source_key").notNull(),
    source: jsonb("source").$type<ExternalSkillSource>().notNull(),
    scope: text("scope").$type<ExternalSkillScope>().notNull().default("workspace"),
    name: text("name").notNull(),
    description: text("description").notNull(),
    status: text("status").$type<ExternalSkillStatus>().notNull().default("enabled"),
    // Set in the same transaction as the first version; no FK so the two tables can reference each other.
    activeVersionId: text("active_version_id"),
    upstreamStatus: text("upstream_status")
      .$type<ExternalSkillUpstreamStatus>()
      .notNull()
      .default("unchecked"),
    upstreamCheckedAt: ts("upstream_checked_at"),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    disabledAt: ts("disabled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("external_skills_source_uq").on(t.workspaceId, t.sourceKey),
    index("external_skills_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
    index("external_skills_name_idx").on(t.workspaceId, t.name),
    index("external_skills_platform_idx").on(t.id).where(sql`${t.scope} = 'platform'`),
  ],
);

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
    storagePrefix: text("storage_prefix").notNull(),
    importKey: text("import_key"),
    // Null only for versions stored before the risk scanner existed (data-only imports).
    risk: jsonb("risk").$type<SkillRiskReport>(),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("external_skill_versions_content_uq").on(t.skillId, t.contentHash),
    uniqueIndex("external_skill_versions_import_key_uq")
      .on(t.workspaceId, t.importKey)
      .where(sql`${t.importKey} is not null`),
    index("external_skill_versions_skill_idx").on(t.skillId, t.id),
  ],
);
