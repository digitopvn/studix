import type { Job } from "@studix/core";
import { createLogger, StudixError } from "@studix/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createJobExecutor,
  type JobExecutorDeps,
  StageFailedAfterSpend,
  type StageUsage,
  type WorkerJobQueue,
  type WorkflowDefinition,
} from "../src/index.ts";

const job = {
  id: "job_1",
  organizationId: "org_1",
  workspaceId: "ws_1",
  kind: "test.abort-spend",
  status: "running",
  progress: 0,
  attempts: 1,
  maxAttempts: 1,
  spentCents: 0,
  cancelRequested: false,
} as unknown as Job;

const GRACE_MS = 2_000;

const cancelRequested = { value: false };

function fakeQueue() {
  const settled = () => Promise.resolve(true);
  return {
    leaseMs: 60_000,
    heartbeat: vi.fn(async () => ({ held: true, cancelRequested: cancelRequested.value })),
    updateProgress: vi.fn(settled),
    writeStage: vi.fn(settled),
    recordUsage: vi.fn(settled),
    complete: vi.fn(settled),
    fail: vi.fn(settled),
    cancel: vi.fn(settled),
    retry: vi.fn(settled),
    release: vi.fn(settled),
    park: vi.fn(settled),
  } as unknown as WorkerJobQueue & { recordUsage: ReturnType<typeof vi.fn> };
}

/** A media provider that charges 3¢ per finished call; the next call blocks until the test releases it. */
function fakeMediaProvider() {
  const calls: Array<{ release: () => void }> = [];
  return {
    calls,
    generate(label: string): Promise<StageUsage> {
      return new Promise((resolve) => {
        const usage: StageUsage = { item: label, kind: "media", quantity: 1, unit: "image", costCents: 3 };
        if (label === "first") return resolve(usage);
        calls.push({ release: () => resolve(usage) });
      });
    },
  };
}

function executorFor(queue: WorkerJobQueue, workflow: WorkflowDefinition) {
  return createJobExecutor({
    queue,
    workflows: [workflow],
    jobs: { listStages: async () => [] } as unknown as JobExecutorDeps["jobs"],
    approvals: {} as JobExecutorDeps["approvals"],
    approvalPolicy: {} as JobExecutorDeps["approvalPolicy"],
    approvalTtlMs: 1,
    billing: { authorizeSpend: async () => ({ allowed: true }) } as unknown as JobExecutorDeps["billing"],
    ledger: { record: async () => ({}), jobCostCents: async () => 0 } as unknown as JobExecutorDeps["ledger"],
    clock: { now: () => new Date() },
    logger: createLogger({}, { level: "error", write: () => {} }),
    heartbeatIntervalMs: 1_000,
    abortGraceMs: GRACE_MS,
  });
}

function singleStage(run: WorkflowDefinition["stages"][number]["run"]): WorkflowDefinition {
  return { kind: job.kind, stages: [{ name: "media", run }], result: () => ({}) };
}

function billed(queue: ReturnType<typeof fakeQueue>): string[] {
  return queue.recordUsage.mock.calls.map((c) => (c[2] as { costCents: number }).costCents.toString());
}

beforeEach(() => {
  cancelRequested.value = false;
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("spend of a stage aborted by cancel or deadline", () => {
  it("bills the paid call a stage reports after it observes the abort", async () => {
    const provider = fakeMediaProvider();
    const queue = fakeQueue();
    const workflow = singleStage(async (stage) => {
      const spent = [await provider.generate("first")];
      await new Promise((resolve) => stage.signal.addEventListener("abort", resolve, { once: true }));
      throw new StageFailedAfterSpend(new StudixError("CANCELLED", "aborted"), spent);
    });
    const shutdown = new AbortController();
    const outcome = executorFor(queue, workflow).execute(job, "w1", shutdown.signal);

    await vi.advanceTimersByTimeAsync(10);
    cancelRequested.value = true;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await outcome).toBe("cancelled");

    expect(billed(queue)).toEqual(["3"]);
  });

  it("bills a stage that finishes while the abort is in flight", async () => {
    const provider = fakeMediaProvider();
    const queue = fakeQueue();
    const workflow = singleStage(async () => {
      const first = await provider.generate("first");
      const second = await provider.generate("second");
      return { output: {}, usage: [first, second] };
    });
    const shutdown = new AbortController();
    const outcome = executorFor(queue, workflow).execute(job, "w1", shutdown.signal);
    await vi.advanceTimersByTimeAsync(10);
    cancelRequested.value = true;
    await vi.advanceTimersByTimeAsync(1_100);
    provider.calls[0]?.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBe("cancelled");

    expect(billed(queue)).toEqual(["3", "3"]);
  });

  it("does not hold the worker past the grace period for a stage that ignores the abort", async () => {
    const queue = fakeQueue();
    const workflow = singleStage(() => new Promise(() => {}));
    const shutdown = new AbortController();
    let finished = false;
    const outcome = executorFor(queue, workflow)
      .execute(job, "w1", shutdown.signal)
      .then(() => {
        finished = true;
      });
    await vi.advanceTimersByTimeAsync(10);
    cancelRequested.value = true;
    await vi.advanceTimersByTimeAsync(1_000 + GRACE_MS - 100);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await outcome;
    expect(finished).toBe(true);
    expect(billed(queue)).toEqual([]);
  });

  it("bills a stage that reports its spend after the job deadline", async () => {
    const queue = fakeQueue();
    const workflow = singleStage(async (stage) => {
      await new Promise((resolve) => stage.signal.addEventListener("abort", resolve, { once: true }));
      throw new StageFailedAfterSpend(new StudixError("TIMEOUT", "deadline"), [
        { item: "first", kind: "media", quantity: 1, unit: "image", costCents: 3 },
      ]);
    });
    const outcome = executorFor(queue, workflow).execute(
      { ...job, deadlineAt: new Date(Date.now() + 500) } as Job,
      "w1",
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(600);
    await outcome;
    expect(billed(queue)).toEqual(["3"]);
  });

  it("does not wait for a stage when the worker shuts down", async () => {
    const queue = fakeQueue();
    const workflow = singleStage(() => new Promise(() => {}));
    const shutdown = new AbortController();
    const outcome = executorFor(queue, workflow).execute(job, "w1", shutdown.signal);
    await vi.advanceTimersByTimeAsync(10);
    shutdown.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBe("released");
  });
});
