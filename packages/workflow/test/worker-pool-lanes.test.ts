import type { Job } from "@studix/core";
import { createLogger } from "@studix/shared";
import { describe, expect, it, vi } from "vitest";
import type { ClaimOptions, JobExecutor, WorkerJobQueue } from "../src/index.ts";
import { createWorkerPool } from "../src/index.ts";

function poolWith(concurrency: number, reservedLightSlots?: number) {
  const claims: { workerId: string; options?: ClaimOptions }[] = [];
  const queue = {
    leaseMs: 1000,
    claim: vi.fn(async (workerId: string, options?: ClaimOptions) => {
      claims.push({ workerId, options });
      return undefined as Job | undefined;
    }),
    failExhaustedLeases: vi.fn(async () => 0),
    resumeDecidedApprovals: vi.fn(async () => 0),
    failExpiredApprovals: vi.fn(async () => 0),
    expireHostHandoffs: vi.fn(async () => 0),
  } as unknown as WorkerJobQueue;
  const pool = createWorkerPool({
    queue,
    executor: { execute: vi.fn() } as unknown as JobExecutor,
    workerId: "w",
    concurrency,
    reservedLightSlots,
    logger: createLogger({ level: "silent" }),
    pollIntervalMs: 5,
  });
  return { pool, claims };
}

async function skipFlags(concurrency: number, reserved?: number) {
  const { pool, claims } = poolWith(concurrency, reserved);
  pool.start();
  await vi.waitFor(() => expect(new Set(claims.map((c) => c.workerId)).size).toBe(concurrency));
  await pool.stop(100);
  const byLoop = new Map(claims.map((c) => [c.workerId, c.options?.skipLongAgentJobs]));
  return [...byLoop.entries()].sort().map(([, skip]) => skip);
}

describe("worker pool lanes", () => {
  it("keeps one slot free of long agent jobs once there are two or more", async () => {
    expect(await skipFlags(2)).toEqual([false, true]);
    expect(await skipFlags(3)).toEqual([false, false, true]);
  });

  it("has no reserved slot with a single loop", async () => {
    expect(await skipFlags(1)).toEqual([false]);
  });

  it("never reserves every slot", async () => {
    expect(await skipFlags(2, 5)).toEqual([false, true]);
  });
});
