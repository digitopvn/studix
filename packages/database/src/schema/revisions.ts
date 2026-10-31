import type { IrNodeKind, LineageInputKind } from "@studix/core";
import { index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns.ts";
import { jobs } from "./jobs.ts";
import { assetVersions, projectVersions, videoProjects } from "./projects.ts";
import { tenantColumns } from "./tenancy.ts";

/**
 * Immutable scene/shot revisions, next to the project versions that introduced them. One row per distinct
 * dependency digest of a node, so an unchanged node keeps its revision across versions.
 */
export const irNodeRevisions = pgTable(
  "ir_node_revisions",
  {
    id: id(),
    ...tenantColumns(),
    projectId: text("project_id")
      .notNull()
      .references(() => videoProjects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IrNodeKind>().notNull(),
    nodeId: text("node_id").notNull(),
    revision: integer("revision").notNull(),
    digest: text("digest").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    versionId: text("version_id")
      .notNull()
      .references(() => projectVersions.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ir_node_revisions_node_revision_uq").on(t.projectId, t.kind, t.nodeId, t.revision),
    uniqueIndex("ir_node_revisions_node_digest_uq").on(t.projectId, t.kind, t.nodeId, t.digest),
  ],
);

/** Which scene/shot revisions make up a project version. */
export const projectVersionNodes = pgTable(
  "project_version_nodes",
  {
    ...tenantColumns(),
    versionId: text("version_id")
      .notNull()
      .references(() => projectVersions.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IrNodeKind>().notNull(),
    nodeId: text("node_id").notNull(),
    /** Position of the node in the IR (scenes, then each scene's shots, in document order). */
    position: integer("position").notNull(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => irNodeRevisions.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.kind, t.nodeId] }),
    index("project_version_nodes_revision_idx").on(t.revisionId),
  ],
);

/** Inputs each generated asset version was derived from (asset versions or scene/shot revisions). */
export const assetLineage = pgTable(
  "asset_lineage",
  {
    id: id(),
    ...tenantColumns(),
    assetVersionId: text("asset_version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    inputKind: text("input_kind").$type<LineageInputKind>().notNull(),
    inputId: text("input_id").notNull(),
    role: text("role"),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("asset_lineage_output_input_uq").on(t.assetVersionId, t.inputKind, t.inputId),
    index("asset_lineage_input_idx").on(t.workspaceId, t.inputKind, t.inputId),
  ],
);

/** Stage outputs memoized by cacheKey per tenant: a stage with a cached key is neither re-run nor re-paid. */
export const stageCache = pgTable(
  "stage_cache",
  {
    id: id(),
    ...tenantColumns(),
    stage: text("stage").notNull(),
    cacheKey: text("cache_key").notNull(),
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("stage_cache_key_uq").on(t.organizationId, t.workspaceId, t.stage, t.cacheKey)],
);
