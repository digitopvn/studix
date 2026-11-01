import type { Job, MediaJobRecord, TenantContext } from "@studix/core";
import { createInMemoryJobStore } from "@studix/core/testing";
import { createLogger, StudixError } from "@studix/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createJobExecutor,
  type JobExecutorDeps,
  type StageContext,
  type WorkerJobQueue,
  type WorkflowDefinition,
} from "../src/index.ts";

const clock = { now: () => new Date("2026-01-01T00:00:00Z") };
const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

const record = (state: MediaJobRecord["state"], updatedAt: string): MediaJobRecord => ({
  idempotencyKey: "job_1:frames:ad-1",
  kind: "image",
  model: "m",
  job: { provider: "multix", id: "up_1" },
  attempt: 1,
  state,
  estimatedCostCents: 1,
  submittedAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
});

function harness(stage: (s: StageContext) => Promise<void>) {
  const { jobs } = createInMemoryJobStore(clock);
  const settled = () => Promise.resolve(true);
  const queue = {
    leaseMs: 60_000,
    heartbeat: async () => ({ held: true, cancelRequested: false }),
    updateProgress: settled,
    writeStage: vi.fn(async (job: Job, _w: string, row: Parameters<WorkerJobQueue["writeStage"]>[2]) => {
      await jobs.upsertStage(ctx, { ...row, jobId: job.id, attempt: job.attempts } as never);
      return true;
    }),
    recordUsage: settled,
    complete: vi.fn(settled),
    fail: vi.fn(settled),
    cancel: vi.fn(settled),
    retry: vi.fn(settled),
    release: vi.fn(settled),
    park: vi.fn(settled),
  };
  const workflow: WorkflowDefinition = {
    kind: "test.media",
    stages: [
      {
        name: "frames",
        async run(s) {
          await stage(s);
          return { output: {} };
        },
      },
    ],
    result: () => ({ ok: true }),
  };
  const executor = createJobExecutor({
    queue: queue as unknown as WorkerJobQueue,
    workflows: [workflow],
    jobs,
    approvals: {} as JobExecutorDeps["approvals"],
    approvalPolicy: {} as JobExecutorDeps["approvalPolicy"],
    approvalTtlMs: 1,
    billing: { authorizeSpend: async () => ({ allowed: true }) } as unknown as JobExecutorDeps["billing"],
    ledger: { record: async () => ({}), jobCostCents: async () => 0 } as unknown as JobExecutorDeps["ledger"],
    clock,
    logger: createLogger({}, { level: "error", write: () => {} }),
    heartbeatIntervalMs: 10_000,
  });
  const run = (attempts: number) =>
    executor.execute(
      {
        id: "job_1",
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        kind: "test.media",
        status: "running",
        payload: {},
        progress: 0,
        attempts,
        maxAttempts: 3,
        spentCents: 0,
        cancelRequested: false,
      } as unknown as Job,
      "worker-1",
      new AbortController().signal,
    );
  return { run, queue, jobs };
}

describe("stage media journal", () => {
  it("persists each put on the running stage row and hands the newest record to the next attempt", async () => {
    const seen: Array<MediaJobRecord | undefined> = [];
    let attempt = 0;
    const h = harness(async (s) => {
      attempt++;
      if (attempt === 1) {
        await s.mediaJournal.put(ctx, record("submitted", "2026-01-01T00:00:01.000Z"));
        await s.mediaJournal.put(ctx, record("completed", "2026-01-01T00:00:02.000Z"));
        throw new StudixError("UNAVAILABLE", "worker lost", { retryable: true });
      }
      seen.push(await s.mediaJournal.get(ctx, "job_1:frames:ad-1"));
    });

    await h.run(1);
    expect(h.queue.retry).toHaveBeenCalledOnce();
    const persisted = h.queue.writeStage.mock.calls
      .map(([, , row]) => row)
      .filter((row) => row.mediaJobs !== undefined);
    expect(persisted.map((row) => row.mediaJobs?.[0]?.state)).toEqual(["submitted", "completed"]);
    expect(persisted.every((row) => row.status === "running")).toBe(true);

    await h.run(2);
    expect(seen).toEqual([record("completed", "2026-01-01T00:00:02.000Z")]);
    expect(h.queue.complete).toHaveBeenCalledOnce();
  });

  it("lets only one of two racing intents claim a key, and a later attempt claim a failed one", async () => {
    const outcomes: boolean[] = [];
    const intent = (attempt: number, at: string): MediaJobRecord => {
      const { job: _job, ...rest } = record("submitting", at);
      return { ...rest, attempt };
    };
    const h = harness(async (s) => {
      outcomes.push(
        ...(await Promise.all([
          s.mediaJournal.claim(ctx, intent(1, "2026-01-01T00:00:01.000Z")),
          s.mediaJournal.claim(ctx, intent(1, "2026-01-01T00:00:01.000Z")),
        ])),
      );
      await s.mediaJournal.put(ctx, { ...record("failed", "2026-01-01T00:00:02.000Z"), attempt: 1 });
      outcomes.push(await s.mediaJournal.claim(ctx, intent(1, "2026-01-01T00:00:03.000Z")));
      outcomes.push(await s.mediaJournal.claim(ctx, intent(2, "2026-01-01T00:00:03.000Z")));
    });
    await h.run(1);
    expect(outcomes).toEqual([true, false, false, true]);
    const stored = await h.jobs.listStages(ctx, "job_1");
    expect(stored[0]?.mediaJobs?.[0]).toMatchObject({ state: "submitting", attempt: 2 });
  });

  it("keeps another workspace out of the journal", async () => {
    const other: TenantContext = { ...ctx, workspaceId: "ws_2" };
    const outcomes: unknown[] = [];
    const h = harness(async (s) => {
      await s.mediaJournal.put(ctx, record("submitted", "2026-01-01T00:00:01.000Z"));
      outcomes.push(await s.mediaJournal.get(other, "job_1:frames:ad-1"));
      outcomes.push(
        await s.mediaJournal.put(other, record("completed", "2026-01-01T00:00:02.000Z")).catch((e) => e.code),
      );
      outcomes.push(
        await s.mediaJournal
          .claim(other, { ...record("submitting", "2026-01-01T00:00:03.000Z"), idempotencyKey: "k2" })
          .catch((e) => e.code),
      );
    });
    await h.run(1);
    expect(outcomes).toEqual([undefined, "FORBIDDEN", "FORBIDDEN"]);
  });
});
