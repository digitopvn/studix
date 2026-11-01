import type { Clock } from "@studix/shared";
import type { AgentHandoff } from "../entities/agent-handoff.ts";
import type { AgentHandoffRepository } from "../repositories/agent-handoff-repository.ts";
import type { JobRepository } from "../repositories/job-repository.ts";
import { InMemoryTenantTable } from "./in-memory-table.ts";

/**
 * In-memory agent handoffs with the same rules as Postgres. `jobs` is the store the tasks' jobs live in,
 * so an accepted submission requeues its parked job like the database transaction does.
 */
export function createInMemoryAgentHandoffRepository(
  clock: Clock,
  jobs: JobRepository,
): AgentHandoffRepository {
  const handoffs = new InMemoryTenantTable<AgentHandoff>("aho", clock);
  const latest = (ctx: Parameters<AgentHandoffRepository["get"]>[0], jobId: string, stage: string) =>
    handoffs.filter(ctx, (h) => h.jobId === jobId && h.stage === stage)[0];

  return {
    async open(ctx, input) {
      const pending = handoffs.filter(
        ctx,
        (h) => h.jobId === input.jobId && h.stage === input.stage && h.status === "pending",
      )[0];
      if (pending) return { handoff: pending, created: false };
      return { handoff: handoffs.insert(ctx, { ...input, status: "pending" }), created: true };
    },
    async get(ctx, id) {
      return handoffs.get(ctx, id);
    },
    async findLatest(ctx, jobId, stage) {
      return latest(ctx, jobId, stage);
    },
    async listPending(ctx, query = {}) {
      const waiting = new Set<string>();
      for (const h of handoffs.filter(ctx, (row) => row.status === "pending")) {
        if ((await jobs.get(ctx, h.jobId))?.status === "waiting_host") waiting.add(h.id);
      }
      return handoffs.page(
        ctx,
        query,
        (h) => waiting.has(h.id) && (query.jobId === undefined || h.jobId === query.jobId),
      );
    },
    async submit(ctx, submission) {
      const handoff = handoffs.get(ctx, submission.id);
      if (!handoff) return { status: "rejected", reason: "not_found" };
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
      const job = await jobs.get(ctx, handoff.jobId);
      // A parked job keeps the attempt counter one below the attempt that parked it.
      if (job?.status !== "waiting_host" || job.attempts !== handoff.attempt - 1) {
        return { status: "rejected", reason: "not_waiting", handoff };
      }
      await jobs.update(ctx, job.id, { status: "queued", runAfter: now }, { expectStatus: ["waiting_host"] });
      const accepted = handoffs.update(ctx, handoff.id, {
        status: "submitted",
        output: submission.output,
        outputDigest: submission.outputDigest,
        usage: submission.usage,
        submittedBy: submission.submittedBy,
        submittedAt: now,
      });
      return { status: "accepted", handoff: accepted };
    },
  };
}
