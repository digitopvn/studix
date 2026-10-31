import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobBudgetPolicy, createPostgresUsageLedger } from "@studix/billing";
import { createDefaultApprovalPolicy, type MediaJobRecord, type TenantContext } from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { StudixError } from "@studix/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createJobExecutor,
  createWorkerJobQueue,
  type StageContext,
  type WorkflowDefinition,
} from "../src/index.ts";
import { silentLogger, tenant } from "./workflow-test-harness.ts";

const db = withTestDatabase();
const human = { type: "user" as const, id: "usr_reviewer" };
const KEY = (jobId: string) => `${jobId}:media:asset-1`;

/**
 * Two stages. `first` is plain. `second` is gated, submits one paid upstream job through the stage journal
 * the first time, then fails non-retryably until `storageFixed`: the shape of a bucket that was missing
 * after the provider already charged for the image.
 */
function scenario() {
  const state = { firstRuns: 0, submitted: 0, collected: 0, storageFixed: false };
  const workflow: WorkflowDefinition = {
    kind: "test.resume",
    stages: [
      {
        name: "first",
        async run() {
          state.firstRuns++;
          return { output: { done: true } };
        },
      },
      {
        name: "second",
        approval: { action: "render.final", estimateCostCents: () => 5000 },
        async run(s: StageContext) {
          const key = KEY(s.job.id);
          const known = await s.mediaJournal.get(s.ctx, key);
          let upstreamJob: string;
          if (known?.state === "completed") {
            state.collected++;
            upstreamJob = `${known.job?.provider}:${known.job?.id}`;
          } else {
            state.submitted++;
            const record: MediaJobRecord = {
              idempotencyKey: key,
              kind: "image",
              model: "m",
              job: { provider: "sume", id: "up_1" },
              attempt: 1,
              state: "completed",
              estimatedCostCents: 2,
              receiptCents: 2,
              submittedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            await s.mediaJournal.put(s.ctx, record);
            upstreamJob = "sume:up_1";
          }
          if (!state.storageFixed) {
            throw new StudixError("UNAVAILABLE", "bucket missing", { retryable: false });
          }
          return {
            output: { upstreamJob },
            usage: [
              {
                item: "media-asset-1",
                kind: "media.generation",
                quantity: 1,
                unit: "image",
                costCents: 2,
                upstreamJob,
              },
            ],
          };
        },
      },
    ],
    result: (outputs) => ({ outputs }),
  };
  return { state, workflow };
}

function worker(workflow: WorkflowDefinition, id: string) {
  const { repos } = db.current;
  const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
  const executor = createJobExecutor({
    queue,
    jobs: repos.jobs,
    approvals: repos.approvals,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
    approvalTtlMs: 3_600_000,
    billing: createJobBudgetPolicy(),
    ledger: createPostgresUsageLedger(db.current.db),
    clock: { now: () => new Date() },
    logger: silentLogger,
    heartbeatIntervalMs: 50,
    retryBackoff: { baseMs: 10, maxMs: 50 },
    workflows: [workflow],
    services: { workRoot: mkdtempSync(join(tmpdir(), "studix-retry-test-")) },
  });
  const shutdown = new AbortController();
  return {
    queue,
    async runOnce() {
      const job = await queue.claim(id);
      return job ? { job, outcome: await executor.execute(job, id, shutdown.signal) } : undefined;
    },
  };
}

async function usageCount(ctx: TenantContext, jobId: string): Promise<number> {
  const page = await db.current.repos.usage.list(ctx, { limit: 100 });
  return page.items.filter((u) => u.jobId === jobId).length;
}

describe("retrying a failed job", () => {
  it("resumes the same job: keeps checkpoints and the journal, pays nothing twice, re-asks no gate", async () => {
    const ctx = await tenant(db.current, "retry");
    const { repos } = db.current;
    const { state, workflow } = scenario();
    const w = worker(workflow, "w1");
    const { job } = await repos.queue.enqueue(ctx, {
      kind: "test.resume",
      payload: {},
      createdBy: human,
      budgetCents: 500,
      maxAttempts: 1,
      deadlineAt: new Date(Date.now() + 60_000),
    });

    // The gate of `second` is decided once, by a person.
    expect((await w.runOnce())?.outcome).toBe("waiting_approval");
    const gate = (await repos.approvals.findLatest(ctx, { type: "job", id: job.id }, "render.final"))!;
    await repos.approvals.decide(ctx, gate.id, {
      status: "approved",
      decidedBy: human,
      decidedAt: new Date(),
    });
    expect(await w.queue.resumeDecidedApprovals()).toBe(1);

    expect((await w.runOnce())?.outcome).toBe("failed");
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(state).toMatchObject({ firstRuns: 1, submitted: 1, collected: 0 });
    // Nothing else can requeue it: a still-failed job is not claimable.
    expect(await w.runOnce()).toBeUndefined();

    // Only a failed job is retryable.
    const other = (await repos.queue.enqueue(ctx, { kind: "x", payload: {}, createdBy: human })).job;
    await expect(repos.queue.retry(ctx, other.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repos.queue.retry(await tenant(db.current, "intruder"), job.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await repos.queue.cancel(ctx, other.id);

    state.storageFixed = true;
    const requeued = await repos.queue.retry(ctx, job.id);
    expect(requeued).toMatchObject({ id: job.id, status: "queued", error: undefined, finishedAt: undefined });
    expect(requeued.maxAttempts).toBeGreaterThan(requeued.attempts);
    expect(requeued.deadlineAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);

    expect((await w.runOnce())?.outcome).toBe("succeeded");
    // The finished stage is not run again, the paid call is collected, the decided gate is not re-asked.
    expect(state).toMatchObject({ firstRuns: 1, submitted: 1, collected: 1 });
    const approvals = await repos.approvals.list(ctx, { subject: { type: "job", id: job.id }, limit: 20 });
    expect(approvals.items).toHaveLength(1);
    expect(await usageCount(ctx, job.id)).toBe(1);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "succeeded", spentCents: 2 });
  });
  it("retries a job born at a gate with the window the caller asked for, not the time it waited", async () => {
    const ctx = await tenant(db.current, "retry-window");
    const { repos } = db.current;
    const { job } = await repos.queue.enqueue(ctx, {
      kind: "test.resume",
      payload: {},
      createdBy: human,
      initialStatus: "waiting_approval",
      deadlineAt: new Date(Date.now() + 60_000),
    });
    expect(job.deadlineWindowMs).toBeGreaterThan(59_000);
    expect(job.deadlineWindowMs).toBeLessThanOrEqual(60_000);
    // The job waited at the gate for ten minutes before it was claimed and failed.
    await db.current.db.execute(
      sql`update jobs set status = 'failed', created_at = now() - interval '10 minutes', deadline_at = now() - interval '1 minute', deadline_remaining_ms = null where id = ${job.id}`,
    );
    const requeued = await repos.queue.retry(ctx, job.id);
    const window = requeued.deadlineAt!.getTime() - Date.now();
    expect(window).toBeGreaterThan(55_000);
    expect(window).toBeLessThanOrEqual(60_000);
  });
});
