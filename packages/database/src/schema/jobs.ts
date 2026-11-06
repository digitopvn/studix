import type {
  ApprovalAction,
  ApprovalChanges,
  ApprovalStatus,
  ApprovalSubjectType,
  JobStatus,
  MediaJobRecord,
  StageStatus,
  WorkflowRunStatus,
} from "@studix/core";
import type { StudixErrorPayload } from "@studix/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, ts, updatedAt } from "./columns.ts";
import { videoProjects } from "./projects.ts";
import { tenantColumns } from "./tenancy.ts";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: id(),
    ...tenantColumns(),
    projectId: text("project_id").references(() => videoProjects.id, { onDelete: "cascade" }),
    template: text("template").notNull(),
    status: text("status").$type<WorkflowRunStatus>().notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("workflow_runs_tenant_idx").on(t.workspaceId, t.organizationId, t.id)],
);

/**
 * Durable job queue. Workers claim with `FOR UPDATE SKIP LOCKED` on (status, run_after), hold a lease
 * (`locked_by`, `lease_expires_at`) renewed by heartbeat, and recover jobs whose lease expired.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    ...tenantColumns(),
    projectId: text("project_id").references(() => videoProjects.id, { onDelete: "cascade" }),
    workflowRunId: text("workflow_run_id").references(() => workflowRuns.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    status: text("status").$type<JobStatus>().notNull(),
    stage: text("stage"),
    progress: real("progress").notNull().default(0),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<StudixErrorPayload>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: ts("run_after").notNull().defaultNow(),
    lockedBy: text("locked_by"),
    leaseExpiresAt: ts("lease_expires_at"),
    idempotencyKey: text("idempotency_key"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    /**
     * The request a parked job is waiting on (action and scope key), set when the worker parks it and
     * cleared when it claims the job again. Null on jobs parked elsewhere (the studio service parks a
     * costly job before the worker sees it), where the sweeper falls back to the scope-key convention.
     */
    parkedAction: text("parked_action").$type<ApprovalAction>(),
    parkedScopeKey: text("parked_scope_key"),
    deadlineAt: ts("deadline_at"),
    deadlineRemainingMs: bigint("deadline_remaining_ms", { mode: "number" }),
    deadlineWindowMs: bigint("deadline_window_ms", { mode: "number" }),
    budgetCents: integer("budget_cents"),
    spentCents: integer("spent_cents").notNull().default(0),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    uniqueIndex("jobs_workspace_idempotency_uq").on(t.workspaceId, t.idempotencyKey),
    index("jobs_claim_idx").on(t.runAfter).where(sql`${t.status} = 'queued'`),
    index("jobs_lease_idx").on(t.leaseExpiresAt).where(sql`${t.status} = 'running'`),
    index("jobs_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
    index("jobs_project_idx").on(t.projectId, t.id),
  ],
);

/** Stage attempts of a job; checkpoint outputs allow resume after a worker crash. */
export const stages = pgTable(
  "stages",
  {
    id: id(),
    ...tenantColumns(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status").$type<StageStatus>().notNull(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<StudixErrorPayload>(),
    /** Upstream media jobs this attempt submitted; read back by later attempts to resume, never resubmit. */
    mediaJobs: jsonb("media_jobs").$type<MediaJobRecord[]>(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("stages_job_name_attempt_uq").on(t.jobId, t.name, t.attempt)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    ...tenantColumns(),
    action: text("action").$type<ApprovalAction>().notNull(),
    subjectType: text("subject_type").$type<ApprovalSubjectType>().notNull(),
    subjectId: text("subject_id").notNull(),
    status: text("status").$type<ApprovalStatus>().notNull(),
    reason: text("reason").notNull(),
    scopeKey: text("scope_key").notNull().default(""),
    estimatedCostCents: integer("estimated_cost_cents"),
    requestedByType: text("requested_by_type").$type<ActorType>().notNull(),
    requestedById: text("requested_by_id").notNull(),
    decidedByType: text("decided_by_type").$type<ActorType>(),
    decidedById: text("decided_by_id"),
    decidedAt: ts("decided_at"),
    comment: text("comment"),
    /** Targets, note and invalidated nodes of a `changes_requested` creative gate. */
    changes: jsonb("changes").$type<ApprovalChanges>(),
    expiresAt: ts("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("approvals_subject_idx").on(t.workspaceId, t.subjectType, t.subjectId, t.action, t.id),
    index("approvals_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
    // One pending request per subject, action and scope: concurrent openers cannot both create one.
    uniqueIndex("approvals_pending_uq")
      .on(t.workspaceId, t.subjectType, t.subjectId, t.action, t.scopeKey)
      .where(sql`${t.status} = 'pending'`),
  ],
);
