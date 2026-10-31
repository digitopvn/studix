import type { AgentHandoffStatus, AgentHandoffUsage, AgentStageLimits } from "@studix/core";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, ts, updatedAt } from "./columns.ts";
import { jobs } from "./jobs.ts";
import { tenantColumns } from "./tenancy.ts";

/**
 * Agent stages handed to the MCP host agent. One pending task per job stage; a submission is accepted only
 * for the attempt that opened the task, in the same transaction that requeues the parked job.
 */
export const agentHandoffs = pgTable(
  "agent_handoffs",
  {
    id: id(),
    ...tenantColumns(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    attempt: integer("attempt").notNull(),
    round: integer("round").notNull().default(0),
    status: text("status").$type<AgentHandoffStatus>().notNull(),
    instructions: text("instructions").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>().notNull(),
    limits: jsonb("limits").$type<AgentStageLimits>().notNull(),
    expiresAt: ts("expires_at").notNull(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    outputDigest: text("output_digest"),
    usage: jsonb("usage").$type<AgentHandoffUsage>(),
    submittedByType: text("submitted_by_type").$type<ActorType>(),
    submittedById: text("submitted_by_id"),
    submittedAt: ts("submitted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("agent_handoffs_job_stage_idx").on(t.jobId, t.stage, t.id),
    index("agent_handoffs_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
    uniqueIndex("agent_handoffs_pending_uq").on(t.jobId, t.stage).where(sql`${t.status} = 'pending'`),
  ],
);
