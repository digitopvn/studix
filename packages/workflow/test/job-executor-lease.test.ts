import type { Job } from "@studix/core";
import { createLogger } from "@studix/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createJobExecutor,
  type HeartbeatResult,
  type JobExecutorDeps,
  type WorkerJobQueue,
  type WorkflowDefinition,
} from "../src/index.ts";

const LEASE_MS = 10_000;
const INTERVAL_MS = 3_000;
const WORKER = "worker-1";

const job = {
  id: "job_1",
  organizationId: "org_1",
  workspaceId: "ws_1",
  kind: "test.lease",
  status: "running",
  progress: 0,
  attempts: 1,
  maxAttempts: 3,
  spentCents: 0,
  cancelRequested: false,
} as unknown as Job;

type HeartbeatImpl = () => Promise<HeartbeatResult>;
const held: HeartbeatImpl = async () => ({ held: true, cancelRequested: false });

function fakeQueue(heartbeat: HeartbeatImpl = held, leaseMs = LEASE_MS) {
  const settled = () => Promise.resolve(true);
  const queue = {
    leaseMs,
    heartbeat: vi.fn(heartbeat),
    complete: vi.fn(settled),
    fail: vi.fn(settled),
    cancel: vi.fn(settled),
    retry: vi.fn(settled),
    release: vi.fn(settled),
    park: vi.fn(settled),
  };
  return queue as typeof queue & WorkerJobQueue;
}

/** A workflow whose single stage runs until the test lets it finish; it records the abort it observes. */
function controlledWorkflow() {
  let finish: () => void = () => {};
  const state = { signal: undefined as AbortSignal | undefined };
  const workflow: WorkflowDefinition = {
    kind: job.kind,
    stages: [
      {
        name: "work",
        run: async (stage) => {
          state.signal = stage.signal;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { output: {} };
        },
      },
    ],
    result: () => ({ ok: true }),
  };
  return { workflow, state, finish: () => finish() };
}

function makeExecutor(
  queue: WorkerJobQueue,
  workflow: WorkflowDefinition,
  overrides: Partial<JobExecutorDeps> = {},
) {
  return createJobExecutor({
    queue,
    workflows: [workflow],
    jobs: {
      listStages: async () => [],
      update: async () => ({}),
      upsertStage: async () => ({}),
    } as unknown as JobExecutorDeps["jobs"],
    approvals: {} as JobExecutorDeps["approvals"],
    audit: {} as JobExecutorDeps["audit"],
    approvalPolicy: {} as JobExecutorDeps["approvalPolicy"],
    approvalTtlMs: 1,
    billing: { authorizeSpend: async () => ({ allowed: true }) } as unknown as JobExecutorDeps["billing"],
    ledger: {
      record: async () => ({}),
      jobCostCents: async () => 0,
    } as unknown as JobExecutorDeps["ledger"],
    clock: { now: () => new Date() },
    logger: createLogger({}, { level: "error", write: () => {} }),
    heartbeatIntervalMs: INTERVAL_MS,
    ...overrides,
  });
}

function start(executor: ReturnType<typeof makeExecutor>, leaseRequestedAt?: number) {
  const shutdown = new AbortController();
  const outcome = executor.execute(job, WORKER, shutdown.signal, undefined, leaseRequestedAt);
  return { outcome, shutdown };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("job executor construction", () => {
  const { workflow } = controlledWorkflow();

  it("rejects a heartbeat interval that cannot renew the lease before the watchdog fires", () => {
    // interval + margin (min(interval, 5s)) must stay below the lease.
    expect(() => makeExecutor(fakeQueue(held, 6_000), workflow, { heartbeatIntervalMs: 3_000 })).toThrow(
      RangeError,
    );
    expect(() => makeExecutor(fakeQueue(held, 60_000), workflow, { heartbeatIntervalMs: 60_000 })).toThrow(
      RangeError,
    );
    expect(() =>
      makeExecutor(fakeQueue(held, 7_000), workflow, { heartbeatIntervalMs: 3_000 }),
    ).not.toThrow();
  });

  it("accepts the production derivation for every allowed lease length", () => {
    for (const leaseSeconds of [5, 30, 60, 3600]) {
      const leaseMs = leaseSeconds * 1000;
      const heartbeatIntervalMs = Math.max(1000, Math.floor(leaseMs / 3));
      expect(() => makeExecutor(fakeQueue(held, leaseMs), workflow, { heartbeatIntervalMs })).not.toThrow();
    }
  });
});

describe("job executor lease heartbeat", () => {
  it("renews the lease every interval and settles the job when the stages finish", async () => {
    const queue = fakeQueue();
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(queue.heartbeat).toHaveBeenCalledTimes(3);

    stage.finish();
    expect(await outcome).toBe("succeeded");
    expect(queue.complete).toHaveBeenCalledOnce();
  });

  it("retries a failed heartbeat quickly and keeps the attempt alive", async () => {
    let calls = 0;
    const queue = fakeQueue(async () => {
      calls += 1;
      if (calls === 1) throw new Error("database blip");
      return { held: true, cancelRequested: false };
    });
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(queue.heartbeat).toHaveBeenCalledTimes(1);
    // The retry comes after a fifth of the interval (600ms), far sooner than the next regular beat.
    await vi.advanceTimersByTimeAsync(Math.ceil(INTERVAL_MS / 5));
    expect(queue.heartbeat).toHaveBeenCalledTimes(2);
    expect(stage.state.signal?.aborted).toBe(false);

    stage.finish();
    expect(await outcome).toBe("succeeded");
  });

  it("abandons the attempt before the lease lapses when no heartbeat succeeds", async () => {
    const queue = fakeQueue(async () => {
      throw new Error("database unreachable");
    });
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    // The watchdog fires one safety margin (here one interval) before the lease runs out.
    await vi.advanceTimersByTimeAsync(LEASE_MS - INTERVAL_MS - 1);
    expect(stage.state.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stage.state.signal?.aborted).toBe(true);

    expect(await outcome).toBe("lease_lost");
    // Another worker may own the job now, so the outcome must not be written.
    for (const write of [queue.complete, queue.fail, queue.cancel, queue.retry, queue.release, queue.park]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("abandons the attempt when a heartbeat hangs", async () => {
    const queue = fakeQueue(() => new Promise<HeartbeatResult>(() => {}));
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    await vi.advanceTimersByTimeAsync(LEASE_MS);
    expect(stage.state.signal?.aborted).toBe(true);
    expect(await outcome).toBe("lease_lost");
    expect(queue.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("counts a renewed lease from when the heartbeat was sent, not when it answered", async () => {
    // Beats take 2s to answer; after the last success the lease ends LEASE_MS after that beat was sent.
    let calls = 0;
    const queue = fakeQueue(async () => {
      calls += 1;
      if (calls > 1) throw new Error("database unreachable");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return { held: true, cancelRequested: false };
    });
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    // First beat sent at INTERVAL_MS; its lease ends at INTERVAL_MS + LEASE_MS, the watchdog one margin sooner.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + LEASE_MS - INTERVAL_MS - 1);
    expect(stage.state.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stage.state.signal?.aborted).toBe(true);
    expect(await outcome).toBe("lease_lost");
  });

  it("counts the first lease from the claim request when the caller supplies it", async () => {
    const queue = fakeQueue(() => new Promise<HeartbeatResult>(() => {}));
    const stage = controlledWorkflow();
    // The claim was sent 2s before execute() started (slow claim round trip).
    const { outcome } = start(makeExecutor(queue, stage.workflow), Date.now() - 2_000);

    await vi.advanceTimersByTimeAsync(LEASE_MS - INTERVAL_MS - 2_000 - 1);
    expect(stage.state.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stage.state.signal?.aborted).toBe(true);
    expect(await outcome).toBe("lease_lost");
  });

  it("stops when another worker took the job", async () => {
    const queue = fakeQueue(async () => ({ held: false, cancelRequested: false }));
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(await outcome).toBe("lease_lost");
    expect(queue.complete).not.toHaveBeenCalled();
  });

  it("is not affected by a database lease timestamp that disagrees with the worker clock", async () => {
    // The expiry reported by the database is on another clock: far in the past here. The attempt must be
    // governed by the lease length measured on the worker's own clock only.
    const queue = fakeQueue(async () => ({
      held: true,
      cancelRequested: false,
      leaseExpiresAt: new Date("2020-01-01T00:00:00Z"),
    }));
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
    expect(stage.state.signal?.aborted).toBe(false);
    expect(queue.heartbeat).toHaveBeenCalledTimes(5);

    stage.finish();
    expect(await outcome).toBe("succeeded");
  });

  it("extends the watchdog with every successful heartbeat", async () => {
    // Beats succeed for a while, then start failing: the watchdog counts from the last success.
    let calls = 0;
    const queue = fakeQueue(async () => {
      calls += 1;
      if (calls > 2) throw new Error("database unreachable");
      return { held: true, cancelRequested: false };
    });
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    // Last good beat at 2 * interval; the lease then runs out LEASE_MS later, the watchdog one margin sooner.
    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS + LEASE_MS - INTERVAL_MS - 1);
    expect(stage.state.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stage.state.signal?.aborted).toBe(true);
    expect(await outcome).toBe("lease_lost");
  });

  it("aborts with a cancellation when the heartbeat reports a cancel request", async () => {
    const queue = fakeQueue(async () => ({ held: true, cancelRequested: true }));
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(await outcome).toBe("cancelled");
    expect(queue.cancel).toHaveBeenCalledOnce();
  });

  it("leaves no timers behind once the attempt settles", async () => {
    const queue = fakeQueue();
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    stage.finish();
    expect(await outcome).toBe("succeeded");
    expect(vi.getTimerCount()).toBe(0);

    const beats = queue.heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LEASE_MS * 2);
    expect(queue.heartbeat).toHaveBeenCalledTimes(beats);
  });

  it("schedules nothing when a heartbeat resolves after the attempt settled", async () => {
    let release: (hb: HeartbeatResult) => void = () => {};
    const queue = fakeQueue(() => new Promise<HeartbeatResult>((resolve) => (release = resolve)));
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // a beat is now in flight
    stage.finish();
    expect(await outcome).toBe("succeeded");

    release({ held: true, cancelRequested: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timers behind after a lost lease either", async () => {
    const queue = fakeQueue(async () => {
      throw new Error("database unreachable");
    });
    const stage = controlledWorkflow();
    const { outcome } = start(makeExecutor(queue, stage.workflow));

    await vi.advanceTimersByTimeAsync(LEASE_MS);
    expect(await outcome).toBe("lease_lost");
    expect(vi.getTimerCount()).toBe(0);
  });
});
