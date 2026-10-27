import type { Logger } from "@studix/shared";
import type { JobExecutor, JobOutcome } from "./job-executor.ts";
import type { WorkerJobQueue } from "./worker-job-queue.ts";

export interface WorkerPoolOptions {
  queue: WorkerJobQueue;
  executor: JobExecutor;
  /** Process-level worker id (e.g. pod name); each loop claims as `<workerId>/<n>`. */
  workerId: string;
  concurrency: number;
  logger: Logger;
  /** Idle wait between claims when the queue is empty. */
  pollIntervalMs?: number;
  /** How often lease-exhausted jobs are failed and decided approvals resumed. */
  sweepIntervalMs?: number;
  /** Called after each job attempt (metrics/tests). */
  onOutcome?: (jobId: string, outcome: JobOutcome) => void;
}

export interface WorkerPoolStatus {
  running: boolean;
  draining: boolean;
  activeJobs: number;
  /** Time of the last successful queue round trip (claim or sweep). */
  lastQueueContactAt?: Date;
}

export interface WorkerPool {
  start(): void;
  /**
   * Stop claiming, give running attempts `graceMs` to finish, then abort them so they release their
   * leases (the attempt is not consumed). Resolves once every loop has exited.
   */
  stop(graceMs?: number): Promise<void>;
  status(): WorkerPoolStatus;
}

/** N concurrent claim loops over the Postgres queue. */
export function createWorkerPool(options: WorkerPoolOptions): WorkerPool {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  const pollMs = options.pollIntervalMs ?? 1000;
  const sweepMs = options.sweepIntervalMs ?? 5000;
  const { queue, executor, logger } = options;
  const shutdown = new AbortController();
  const wakers = new Set<() => void>();
  let running = false;
  let draining = false;
  let active = 0;
  let lastContact: Date | undefined;
  let lastSweep = 0;
  let loops: Promise<void>[] = [];

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      wakers.add(done);
    });

  const sweep = async () => {
    if (Date.now() - lastSweep < sweepMs) return;
    lastSweep = Date.now();
    const failed = await queue.failExhaustedLeases();
    const resumed = await queue.resumeDecidedApprovals();
    lastContact = new Date();
    if (failed || resumed)
      logger.info("queue sweep", { failedExhaustedLeases: failed, resumedApprovals: resumed });
  };

  const loop = async (index: number) => {
    const workerId = `${options.workerId}/${index}`;
    while (running) {
      try {
        if (index === 0) await sweep();
        const job = await queue.claim(workerId);
        lastContact = new Date();
        if (!job) {
          await sleep(pollMs);
          continue;
        }
        active++;
        try {
          const outcome = await executor.execute(job, workerId, shutdown.signal);
          options.onOutcome?.(job.id, outcome);
        } finally {
          active--;
        }
      } catch (err) {
        logger.error("worker loop error", {
          workerId,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(pollMs);
      }
    }
  };

  return {
    start() {
      if (running || draining) return;
      if (shutdown.signal.aborted) throw new Error("worker pool was shut down; create a new pool");
      running = true;
      loops = Array.from({ length: options.concurrency }, (_, i) => loop(i));
      logger.info("worker pool started", { workerId: options.workerId, concurrency: options.concurrency });
    },

    async stop(graceMs = 30_000) {
      if (!running) return;
      running = false;
      draining = true;
      for (const wake of [...wakers]) wake();
      const all = Promise.all(loops);
      let timer: NodeJS.Timeout | undefined;
      const graceful = await Promise.race([
        all.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), graceMs);
        }),
      ]);
      clearTimeout(timer);
      if (!graceful) {
        logger.warn("grace period over, releasing running jobs", { activeJobs: active });
        shutdown.abort();
      }
      await all;
      draining = false;
      logger.info("worker pool stopped", { workerId: options.workerId });
    },

    status: () => ({ running, draining, activeJobs: active, lastQueueContactAt: lastContact }),
  };
}
