import type { Job } from "@studix/core";
import { createLogger, StudixError } from "@studix/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createJobExecutor,
  type JobExecutorDeps,
  StageFailedAfterSpend,
  type StageUsage,
  type WorkerJobQueue,
  type WorkflowDefinition,
} from "../src/index.ts";

const clock = { now: () => new Date("2026-01-01T00:00:00Z") };

const paid: StageUsage = { item: "gen", kind: "test.media", quantity: 1, unit: "call", costCents: 40 };

function job(): Job {
  return {
    id: "job_1",
    organizationId: "org_1",
    workspaceId: "ws_1",
    kind: "test.media",
    status: "running",
    payload: {},
    progress: 0,
    attempts: 1,
    maxAttempts: 1,
    spentCents: 0,
    cancelRequested: false,
  } as unknown as Job;
}

function fakeQueue(heartbeat: { held: boolean; cancelRequested: boolean }) {
  const settled = () => Promise.resolve(true);
  const queue = {
    leaseMs: 60_000,
    heartbeat: vi.fn(async () => heartbeat),
    updateProgress: vi.fn(settled),
    writeStage: vi.fn(settled),
    recordUsage: vi.fn(settled),
    complete: vi.fn(settled),
    fail: vi.fn(settled),
    cancel: vi.fn(settled),
    retry: vi.fn(settled),
    release: vi.fn(settled),
    park: vi.fn(settled),
  };
  return queue as typeof queue & WorkerJobQueue;
}

/** A fake media stage: a paid call finishes, then the stage settles `settleAfterMs` later. */
function workflow(settle: "return" | "fail" | "never", settleAfterMs: number): WorkflowDefinition {
  return {
    kind: "test.media",
    stages: [
      {
        name: "media",
        async run() {
          if (settle === "never") return new Promise<never>(() => {});
          await new Promise((r) => setTimeout(r, settleAfterMs));
          if (settle === "fail")
            throw new StageFailedAfterSpend(new StudixError("INTERNAL", "download failed"), [paid]);
          return { output: {}, usage: [paid] };
        },
      },
    ],
    result: () => ({}),
  };
}

/** Abort the attempt through the heartbeat: a cancel request, or a lost lease. */
async function runAborted(
  wf: WorkflowDefinition,
  abortGraceMs: number,
  heartbeat = { held: true, cancelRequested: true },
) {
  const queue = fakeQueue(heartbeat);
  const executor = createJobExecutor({
    queue,
    workflows: [wf],
    jobs: { listStages: async () => [] } as unknown as JobExecutorDeps["jobs"],
    approvals: {} as JobExecutorDeps["approvals"],
    approvalPolicy: {} as JobExecutorDeps["approvalPolicy"],
    approvalTtlMs: 1,
    billing: { authorizeSpend: async () => ({ allowed: true }) } as unknown as JobExecutorDeps["billing"],
    ledger: { record: async () => ({}), jobCostCents: async () => 0 } as unknown as JobExecutorDeps["ledger"],
    clock,
    logger: createLogger({}, { level: "error", write: () => {} }),
    heartbeatIntervalMs: 10,
    abortGraceMs,
  });
  await executor.execute(job(), "worker-1", new AbortController().signal);
  return queue;
}

describe("spend of a stage aborted by cancel or deadline", () => {
  it("bills the usage of a stage that returns during the grace period", async () => {
    const queue = await runAborted(workflow("return", 40), 500);
    expect(queue.recordUsage).toHaveBeenCalledTimes(1);
    expect((queue.recordUsage.mock.calls as unknown[][])[0]?.[2]).toMatchObject({
      costCents: 40,
      jobId: "job_1",
    });
  });

  it("bills the usage of a stage that fails after spend during the grace period (cancel)", async () => {
    const queue = await runAborted(workflow("fail", 40), 500);
    expect(queue.recordUsage).toHaveBeenCalledTimes(1);
  });

  it("does not wait past the grace period for a stage that never settles", async () => {
    const started = Date.now();
    const queue = await runAborted(workflow("never", 0), 50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(queue.recordUsage).not.toHaveBeenCalled();
    expect(queue.writeStage).toHaveBeenCalledWith(
      expect.anything(),
      "worker-1",
      expect.objectContaining({ name: "media", finishedAt: expect.any(Date) }),
    );
  });

  it("does not wait or bill when the lease was lost", async () => {
    const started = Date.now();
    const queue = await runAborted(workflow("return", 300), 5000, { held: false, cancelRequested: false });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(queue.recordUsage).not.toHaveBeenCalled();
  });

  it("ignores usage that arrives after the grace period", async () => {
    const queue = await runAborted(workflow("return", 300), 20);
    expect(queue.recordUsage).not.toHaveBeenCalled();
  });
});
