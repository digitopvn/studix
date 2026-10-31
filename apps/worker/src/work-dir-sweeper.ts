import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { findJobStates, type StudixDb } from "@studix/database";
import type { Clock, Logger } from "@studix/shared";

export interface WorkDirSweepOptions {
  db: StudixDb;
  workDir: string;
  /** How long the scratch of a failed job stays: a retry reuses it (synchronous media outputs). */
  retentionMs: number;
  clock: Clock;
  logger: Logger;
}

/** Job scratch directories are named after the job id (`<workDir>/<jobId>`); other entries are not ours. */
const JOB_DIR = /^job_[A-Za-z0-9]+$/;

/**
 * Remove scratch directories no job needs any more and return how many went:
 * - jobs that ended `succeeded` or `cancelled` (finalize cleans up success, a cancel never does),
 * - `failed` jobs that finished longer ago than the retention,
 * - directories of unknown jobs untouched for longer than the retention.
 * Queued, running and parked jobs keep theirs. Directories vanish with `tmpdir()` cleanups and container
 * restarts anyway; this keeps a long-lived worker's disk from growing with every failed job.
 */
export async function sweepWorkDir(options: WorkDirSweepOptions): Promise<number> {
  const { db, workDir, retentionMs, clock, logger } = options;
  const entries = await readdir(workDir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const ids = entries.filter((e) => e.isDirectory() && JOB_DIR.test(e.name)).map((e) => e.name);
  if (ids.length === 0) return 0;
  const byId = await findJobStates(db, ids);
  const cutoff = clock.now().getTime() - retentionMs;
  let removed = 0;
  for (const id of ids) {
    const dir = join(workDir, id);
    const job = byId.get(id);
    let expired: boolean;
    if (!job)
      expired = ((await stat(dir).catch(() => undefined))?.mtimeMs ?? Number.POSITIVE_INFINITY) < cutoff;
    else if (job.status === "succeeded" || job.status === "cancelled") expired = true;
    else expired = job.status === "failed" && (job.finishedAt?.getTime() ?? 0) < cutoff;
    if (!expired) continue;
    try {
      await rm(dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger.warn("could not remove a job work directory", { jobId: id, error: String(err) });
    }
  }
  if (removed > 0) logger.info("removed stale job work directories", { removed });
  return removed;
}

/** Sweep now and then every `intervalMs`; the returned function stops it. Errors are logged, never thrown. */
export function startWorkDirSweeper(options: WorkDirSweepOptions & { intervalMs: number }): () => void {
  const run = () =>
    sweepWorkDir(options).catch((err) =>
      options.logger.warn("work directory sweep failed", { error: String(err) }),
    );
  void run();
  const timer = setInterval(run, options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
