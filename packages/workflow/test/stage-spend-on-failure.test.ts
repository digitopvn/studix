import type { Job, TenantContext } from "@studix/core";
import { createInMemoryJobStore } from "@studix/core/testing";
import { createLogger, StudixError } from "@studix/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createJobExecutor,
  type JobExecutorDeps,
  type StageContext,
  StageFailedAfterSpend,
  type StageUsage,
  type WorkerJobQueue,
  type WorkflowDefinition,
} from "../src/index.ts";

const clock = { now: () => new Date("2026-01-01T00:00:00Z") };
const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

function harness(
  stageRun: (s: StageContext) => Promise<{ output: Record<string, unknown>; usage?: StageUsage[] }>,
) {
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
    recordUsage: vi.fn(async (_job: Job, _worker: string, _line: { costCents: number }) => true),
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
        outputSchema: z.object({ ok: z.literal(true) }),
        run: stageRun,
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
  return { run, queue };
}

const spend: StageUsage = {
  item: "media-a",
  kind: "media_generation",
  quantity: 1,
  unit: "image",
  costCents: 2,
  upstreamJob: "sume:j1",
};

const billed = (h: ReturnType<typeof harness>) =>
  h.queue.recordUsage.mock.calls.map(([, , line]) => line.costCents);

describe("stage spend on failure", () => {
  it("records the spend of a stage that fails after paying", async () => {
    const h = harness(async () => {
      throw new StageFailedAfterSpend(new StudixError("UNAVAILABLE", "put failed", { retryable: false }), [
        spend,
      ]);
    });
    await h.run(1);
    expect(billed(h)).toEqual([2]);
    expect(h.queue.fail).toHaveBeenCalledOnce();
  });

  it("records the spend of a stage whose output fails its schema", async () => {
    const h = harness(async () => ({ output: { ok: false }, usage: [spend] }));
    await h.run(1);
    expect(billed(h)).toEqual([2]);
    expect(h.queue.complete).not.toHaveBeenCalled();
  });
});
