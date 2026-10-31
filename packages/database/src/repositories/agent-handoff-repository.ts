import type { AgentHandoff, AgentHandoffRepository, AgentHandoffSubmitResult } from "@studix/core";
import { type Clock, newId } from "@studix/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "../client.ts";
import { agentHandoffs } from "../schema/agent-handoffs.ts";
import { jobs } from "../schema/jobs.ts";
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

function toHandoff(row: typeof agentHandoffs.$inferSelect): AgentHandoff {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    jobId: row.jobId,
    stage: row.stage,
    attempt: row.attempt,
    round: row.round,
    status: row.status,
    instructions: row.instructions,
    input: row.input,
    outputSchema: row.outputSchema,
    limits: row.limits,
    expiresAt: row.expiresAt,
    output: opt(row.output),
    outputDigest: opt(row.outputDigest),
    usage: opt(row.usage),
    submittedBy:
      row.submittedByType && row.submittedById
        ? actorFrom(row.submittedByType, row.submittedById)
        : undefined,
    submittedAt: opt(row.submittedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createAgentHandoffRepository(db: DbExecutor, clock: Clock): AgentHandoffRepository {
  const pendingOf = async (
    ctx: Parameters<AgentHandoffRepository["get"]>[0],
    jobId: string,
    stage: string,
  ) => {
    const rows = await db
      .select()
      .from(agentHandoffs)
      .where(
        scoped(
          agentHandoffs,
          ctx,
          eq(agentHandoffs.jobId, jobId),
          eq(agentHandoffs.stage, stage),
          eq(agentHandoffs.status, "pending"),
        ),
      )
      .limit(1);
    return rows[0] ? toHandoff(rows[0]) : undefined;
  };

  return {
    async open(ctx, input) {
      const existing = await pendingOf(ctx, input.jobId, input.stage);
      if (existing) return { handoff: existing, created: false };
      const now = clock.now();
      try {
        const rows = await db
          .insert(agentHandoffs)
          .values({
            id: input.id ?? newId("aho"),
            ...tenantValues(ctx),
            jobId: input.jobId,
            stage: input.stage,
            attempt: input.attempt,
            round: input.round,
            status: "pending",
            instructions: input.instructions,
            input: input.input,
            outputSchema: input.outputSchema,
            limits: input.limits,
            expiresAt: input.expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return { handoff: toHandoff(rows[0]!), created: true };
      } catch (err) {
        // A concurrent opener won the one pending slot of this job stage.
        if (!isUniqueViolation(err)) throw err;
        const winner = await pendingOf(ctx, input.jobId, input.stage);
        if (!winner) throw err;
        return { handoff: winner, created: false };
      }
    },

    async get(ctx, id) {
      const rows = await db
        .select()
        .from(agentHandoffs)
        .where(scoped(agentHandoffs, ctx, eq(agentHandoffs.id, id)))
        .limit(1);
      return rows[0] ? toHandoff(rows[0]) : undefined;
    },

    async findLatest(ctx, jobId, stage) {
      const rows = await db
        .select()
        .from(agentHandoffs)
        .where(scoped(agentHandoffs, ctx, eq(agentHandoffs.jobId, jobId), eq(agentHandoffs.stage, stage)))
        .orderBy(desc(agentHandoffs.id))
        .limit(1);
      return rows[0] ? toHandoff(rows[0]) : undefined;
    },

    async listPending(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(agentHandoffs)
        .where(
          scoped(
            agentHandoffs,
            ctx,
            eq(agentHandoffs.status, "pending"),
            query.jobId === undefined ? undefined : eq(agentHandoffs.jobId, query.jobId),
            beforeCursor(agentHandoffs.id, query.cursor),
            sql`exists (select 1 from ${jobs} j where j.id = ${agentHandoffs.jobId}
              and j.workspace_id = ${agentHandoffs.workspaceId} and j.status = 'waiting_host')`,
          ),
        )
        .orderBy(desc(agentHandoffs.id))
        .limit(limit + 1);
      return toPage(rows.map(toHandoff), limit);
    },

    async submit(ctx, submission) {
      const run = async (tx: DbExecutor): Promise<AgentHandoffSubmitResult> => {
        const rows = await tx
          .select()
          .from(agentHandoffs)
          .where(scoped(agentHandoffs, ctx, eq(agentHandoffs.id, submission.id)))
          .for("update");
        if (!rows[0]) return { status: "rejected", reason: "not_found" };
        const handoff = toHandoff(rows[0]);
        if (handoff.attempt !== submission.attempt)
          return { status: "rejected", reason: "stale_attempt", handoff };
        if (handoff.status === "submitted") {
          return handoff.outputDigest === submission.outputDigest
            ? { status: "duplicate", handoff }
            : { status: "rejected", reason: "already_submitted", handoff };
        }
        if (handoff.status !== "pending") return { status: "rejected", reason: "not_waiting", handoff };
        const now = clock.now();
        if (handoff.expiresAt <= now) return { status: "rejected", reason: "expired", handoff };
        // Fencing: the job must still be parked at the attempt that opened the task (park keeps the
        // counter one below it). A job that was cancelled, failed or claimed again matches nothing.
        const requeued = await tx
          .update(jobs)
          .set({ status: "queued", runAfter: now, updatedAt: now })
          .where(
            and(
              scoped(jobs, ctx, eq(jobs.id, handoff.jobId)),
              eq(jobs.status, "waiting_host"),
              eq(jobs.attempts, handoff.attempt - 1),
            ),
          )
          .returning({ id: jobs.id });
        if (requeued.length === 0) return { status: "rejected", reason: "not_waiting", handoff };
        const updated = await tx
          .update(agentHandoffs)
          .set({
            status: "submitted",
            output: submission.output,
            outputDigest: submission.outputDigest,
            usage: submission.usage ?? null,
            submittedByType: submission.submittedBy.type,
            submittedById: submission.submittedBy.id,
            submittedAt: now,
            updatedAt: now,
          })
          .where(eq(agentHandoffs.id, handoff.id))
          .returning();
        await createAuditRepository(tx, clock).append(ctx, {
          actor: submission.submittedBy,
          action: "agent_task.submitted",
          subjectType: "job",
          subjectId: handoff.jobId,
          data: { taskId: handoff.id, stage: handoff.stage, attempt: handoff.attempt },
        });
        return { status: "accepted", handoff: toHandoff(updated[0]!) };
      };
      return db.transaction(run);
    },
  };
}
