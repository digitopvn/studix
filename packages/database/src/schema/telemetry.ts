import type { ActivityLevel, FundingSource, ProviderExecutionStatus } from "@studix/core";
import type { StudixErrorPayload } from "@studix/shared";
import { index, integer, jsonb, numeric, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id } from "./columns.ts";
import { jobs } from "./jobs.ts";
import { tenantColumns } from "./tenancy.ts";

/** Cents with sub-cent precision (token pricing), read back as JS numbers. */
const cents = (name: string) => numeric(name, { precision: 14, scale: 4, mode: "number" });

export const providerExecutions = pgTable(
  "provider_executions",
  {
    id: id(),
    ...tenantColumns(),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    stageId: text("stage_id"),
    provider: text("provider").notNull(),
    model: text("model"),
    operation: text("operation").notNull(),
    status: text("status").$type<ProviderExecutionStatus>().notNull(),
    latencyMs: integer("latency_ms").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costCents: cents("cost_cents").notNull(),
    attempt: integer("attempt").notNull(),
    error: jsonb("error").$type<StudixErrorPayload>(),
    funding: text("funding").$type<FundingSource>().notNull().default("operator"),
    externalId: text("external_id"),
    createdAt: createdAt(),
  },
  (t) => [index("provider_executions_job_idx").on(t.jobId, t.id)],
);

/** Billable usage; UNIQUE(workspace_id, dedupe_key) makes retried recording idempotent. */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    ...tenantColumns(),
    dedupeKey: text("dedupe_key").notNull(),
    kind: text("kind").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 6, mode: "number" }).notNull(),
    unit: text("unit").notNull(),
    costCents: cents("cost_cents").notNull(),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    providerExecutionId: text("provider_execution_id").references(() => providerExecutions.id, {
      onDelete: "set null",
    }),
    funding: text("funding").$type<FundingSource>().notNull().default("operator"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("usage_events_workspace_dedupe_uq").on(t.workspaceId, t.dedupeKey),
    index("usage_events_tenant_time_idx").on(t.workspaceId, t.organizationId, t.createdAt),
  ],
);

/** Append-only audit log. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    ...tenantColumns(),
    actorType: text("actor_type").$type<ActorType>().notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_events_subject_idx").on(t.workspaceId, t.subjectType, t.subjectId, t.id),
    index("audit_events_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
  ],
);

/** Activity and trace events (org/workspace/project/job/stage/provider/model), already redacted. */
export const activityEvents = pgTable(
  "activity_events",
  {
    id: id(),
    ...tenantColumns(),
    name: text("name").notNull(),
    level: text("level").$type<ActivityLevel>().notNull(),
    message: text("message"),
    projectId: text("project_id"),
    jobId: text("job_id"),
    stage: text("stage"),
    provider: text("provider"),
    model: text("model"),
    traceId: text("trace_id"),
    spanId: text("span_id"),
    parentSpanId: text("parent_span_id"),
    durationMs: integer("duration_ms"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_events_job_idx").on(t.workspaceId, t.jobId, t.id),
    index("activity_events_project_idx").on(t.workspaceId, t.projectId, t.id),
    index("activity_events_trace_idx").on(t.traceId),
    index("activity_events_window_idx").on(t.workspaceId, t.createdAt),
    /** Serves the retention sweep, which deletes by age across workspaces. */
    index("activity_events_created_idx").on(t.createdAt),
  ],
);
