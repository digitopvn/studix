import type {
  AssetKind,
  MediaProbe,
  ProjectStatus,
  ProjectVersionSource,
  RenderStatus,
  ReviewStatus,
} from "@studix/core";
import type { StudixErrorPayload } from "@studix/shared";
import type {
  AssetProvenance,
  CreativeBrief,
  RenderPreset,
  RenderSpec,
  Storyboard,
  VideoIR,
  VideoIRPatch,
} from "@studix/video-ir";
import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, ts, updatedAt } from "./columns.ts";
import { tenantColumns } from "./tenancy.ts";

export const videoProjects = pgTable(
  "video_projects",
  {
    id: id(),
    ...tenantColumns(),
    title: text("title").notNull(),
    status: text("status").$type<ProjectStatus>().notNull(),
    brief: jsonb("brief").$type<CreativeBrief>().notNull(),
    workflowTemplate: text("workflow_template"),
    currentVersionId: text("current_version_id"),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("video_projects_tenant_idx").on(t.workspaceId, t.organizationId, t.id)],
);

/** Immutable IR revisions; `version` is 1-based and unique per project. */
export const projectVersions = pgTable(
  "project_versions",
  {
    id: id(),
    ...tenantColumns(),
    projectId: text("project_id")
      .notNull()
      .references(() => videoProjects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    ir: jsonb("ir").$type<VideoIR>().notNull(),
    source: text("source").$type<ProjectVersionSource>().notNull(),
    parentVersionId: text("parent_version_id"),
    patch: jsonb("patch").$type<VideoIRPatch>(),
    idempotencyKey: text("idempotency_key"),
    feedbackId: text("feedback_id"),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("project_versions_project_version_uq").on(t.projectId, t.version),
    uniqueIndex("project_versions_project_idempotency_uq")
      .on(t.projectId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: id(),
    ...tenantColumns(),
    projectId: text("project_id").references(() => videoProjects.id, { onDelete: "set null" }),
    kind: text("kind").$type<AssetKind>().notNull(),
    name: text("name").notNull(),
    currentVersionId: text("current_version_id"),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("assets_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
    index("assets_project_idx").on(t.projectId),
  ],
);

/** Immutable binary revisions with provenance; bytes live in object storage under `storage_key`. */
export const assetVersions = pgTable(
  "asset_versions",
  {
    id: id(),
    ...tenantColumns(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    storageKey: text("storage_key").notNull(),
    /** Storage profile holding the bytes (`env` = the S3_* environment settings). */
    storageProfileId: text("storage_profile_id").notNull().default("env"),
    sha256: text("sha256").notNull(),
    mime: text("mime").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    provenance: jsonb("provenance").$type<AssetProvenance>().notNull(),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("asset_versions_asset_version_uq").on(t.assetId, t.version),
    index("asset_versions_sha_idx").on(t.workspaceId, t.sha256),
    index("asset_versions_storage_key_idx").on(t.workspaceId, t.storageKey),
    index("asset_versions_storage_profile_idx").on(t.storageProfileId),
  ],
);

export const renders = pgTable(
  "renders",
  {
    id: id(),
    ...tenantColumns(),
    projectId: text("project_id")
      .notNull()
      .references(() => videoProjects.id, { onDelete: "cascade" }),
    versionId: text("version_id")
      .notNull()
      .references(() => projectVersions.id, { onDelete: "cascade" }),
    jobId: text("job_id"),
    preset: text("preset").$type<RenderPreset>().notNull(),
    spec: jsonb("spec").$type<RenderSpec>().notNull(),
    status: text("status").$type<RenderStatus>().notNull(),
    assetVersionId: text("asset_version_id").references(() => assetVersions.id, { onDelete: "set null" }),
    storageKey: text("storage_key"),
    /** Storage profile holding the output (`env` = the S3_* environment settings). */
    storageProfileId: text("storage_profile_id").notNull().default("env"),
    probe: jsonb("probe").$type<MediaProbe>(),
    error: jsonb("error").$type<StudixErrorPayload>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("renders_project_idx").on(t.projectId, t.id),
    index("renders_storage_key_idx").on(t.workspaceId, t.storageKey),
    index("renders_storage_profile_idx").on(t.storageProfileId),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    ...tenantColumns(),
    projectId: text("project_id")
      .notNull()
      .references(() => videoProjects.id, { onDelete: "cascade" }),
    versionId: text("version_id").references(() => projectVersions.id, { onDelete: "set null" }),
    authorType: text("author_type").$type<ActorType>().notNull(),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    targetId: text("target_id"),
    atMs: integer("at_ms"),
    endMs: integer("end_ms"),
    status: text("status").$type<ReviewStatus>().notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("reviews_project_idx").on(t.projectId, t.id),
    uniqueIndex("reviews_project_idempotency_uq")
      .on(t.projectId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

/** Append-only storyboard revisions with their review state; `revision` is 1-based per project. */
export const projectStoryboards = pgTable(
  "project_storyboards",
  {
    id: id(),
    ...tenantColumns(),
    projectId: text("project_id")
      .notNull()
      .references(() => videoProjects.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    versionId: text("version_id")
      .notNull()
      .references(() => projectVersions.id, { onDelete: "cascade" }),
    storyboard: jsonb("storyboard").$type<Storyboard>().notNull(),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("project_storyboards_project_revision_uq").on(t.projectId, t.revision)],
);
