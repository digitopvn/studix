import type { Job } from "@studix/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runStages = vi.fn();
vi.mock("../src/stage-runner.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/stage-runner.ts")>()),
  runStages: (...args: unknown[]) => runStages(...args),
}));

const { createJobExecutor } = await import("../src/job-executor.ts");

const LEASE_MS = 30_000;
const INTERVAL_MS = 1_000;
const MARGIN_MS = INTERVAL_MS; // min(interval, 5s)

const job = { id: "job_1", kind: "video.create", attempts: 1, maxAttempts: 3 } as unknown as Job;
const logger = { info() {}, warn() {}, error() {}, debug() {}, child: () => logger };

function setup(overrides: { heartbeat?: () => Promise<unknown>; leaseMs?: number; interval?: number } = {}) {
  const queue = {
    leaseMs: overrides.leaseMs ?? LEASE_MS,
    heartbeat: vi.fn(overrides.heartbeat ?? (async () => ({ held: true, cancelRequested: false }))),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    release: vi.fn(async () => true),
    park: vi.fn(async () => true),
  };
  const executor = createJobExecutor({
    queue,
    workflows: [{ kind: "video.create", stages: [] }],
    heartbeatIntervalMs: overrides.interval ?? INTERVAL_MS,
    clock: { now: () => new Date() },
    logger,
  } as never);
  return { queue, executor };
}

/** Make the stage run until `release` is called or the attempt is aborted. */
function blockStages() {
  let release!: () => void;
  runStages.mockImplementation(
    (_d: unknown, _c: unknown, _j: unknown, _w: unknown, signal: AbortSignal) =>
      new Promise((resolve, reject) => {
        release = () => resolve({ status: "succeeded", result: {} });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  return { release: () => release() };
}

describe("job executor lease heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runStages.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a heartbeat interval that does not leave room for the safety margin", () => {
    expect(() => setup({ leaseMs: 100, interval: 100 })).toThrow(RangeError);
    expect(() => setup({ leaseMs: 6_000, interval: 1_000 })).not.toThrow();
    expect(() => setup({ leaseMs: 6_000, interval: 5_000 })).toThrow(/safety margin/);
  });

  it("renews the lease every interval while the stage runs", async () => {
    const { queue, executor } = setup();
    const stage = blockStages();
    const run = executor.execute(job, "w1", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(queue.heartbeat).toHaveBeenCalledTimes(3);
    stage.release();
    await expect(run).resolves.toBe("succeeded");
  });

  it("retries a failed heartbeat sooner than the interval and keeps the attempt alive", async () => {
    let calls = 0;
    const { queue, executor } = setup({
      heartbeat: async () => {
        if (++calls === 1) throw new Error("db blip");
        return { held: true, cancelRequested: false };
      },
    });
    const stage = blockStages();
    const run = executor.execute(job, "w1", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // failing beat
    await vi.advanceTimersByTimeAsync(INTERVAL_MS / 5); // retry
    expect(queue.heartbeat).toHaveBeenCalledTimes(2);
    stage.release();
    await expect(run).resolves.toBe("succeeded");
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it("abandons the attempt before the lease lapses when no heartbeat succeeds", async () => {
    const { queue, executor } = setup({ heartbeat: async () => Promise.reject(new Error("db down")) });
    blockStages();
    const run = executor.execute(job, "w1", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(LEASE_MS - MARGIN_MS - 1);
    expect(queue.complete).not.toHaveBeenCalled();
    let outcome: string | undefined;
    void run.then((o) => {
      outcome = o;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("lease_lost");
    expect(queue.fail).not.toHaveBeenCalled();
    expect(queue.retry).not.toHaveBeenCalled();
  });

  it("measures the watchdog on the worker clock, not on the lease timestamp the database returns", async () => {
    // A database clock 10 minutes ahead returns a far-future expiry; it must not extend the watchdog.
    const skewed = async () => ({
      held: true,
      cancelRequested: false,
      leaseExpiresAt: new Date(Date.now() + 10 * 60_000 + LEASE_MS),
    });
    let healthy = true;
    const { executor } = setup({
      heartbeat: async () => (healthy ? skewed() : Promise.reject(new Error("down"))),
    });
    blockStages();
    const run = executor.execute(job, "w1", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    healthy = false;
    let outcome: string | undefined;
    void run.then((o) => {
      outcome = o;
    });
    await vi.advanceTimersByTimeAsync(LEASE_MS);
    expect(outcome).toBe("lease_lost");
  });

  it("counts the initial lease from when the claim was sent, not from when execute started", async () => {
    const { executor } = setup({ heartbeat: async () => Promise.reject(new Error("db down")) });
    blockStages();
    const claimSentAt = new Date(Date.now() - 2_000); // a slow claim round trip
    const run = executor.execute(job, "w1", new AbortController().signal, undefined, claimSentAt);
    let outcome: string | undefined;
    void run.then((o) => {
      outcome = o;
    });
    await vi.advanceTimersByTimeAsync(LEASE_MS - MARGIN_MS - 2_000 - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("lease_lost");
  });

  it("stops when the lease is no longer held", async () => {
    const { executor } = setup({ heartbeat: async () => ({ held: false, cancelRequested: false }) });
    blockStages();
    const run = executor.execute(job, "w1", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await expect(run).resolves.toBe("lease_lost");
  });

  it("leaves no timers or further heartbeats after the attempt settles, even with a beat in flight", async () => {
    let resolveBeat!: (v: unknown) => void;
    const { queue, executor } = setup({ heartbeat: () => new Promise((r) => (resolveBeat = r)) });
    const stage = blockStages();
    const run = executor.execute(job, "w1", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // beat sent, never answered
    stage.release();
    await expect(run).resolves.toBe("succeeded");
    resolveBeat({ held: true, cancelRequested: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LEASE_MS * 2);
    expect(queue.heartbeat).toHaveBeenCalledTimes(1);
  });
});
