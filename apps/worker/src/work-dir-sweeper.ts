import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { findJobStates, type StudixDb } from "@studix/database";
import type { Clock, Logger } from "@studix/shared";

type JobState = NonNullable<
  Awaited<ReturnType<typeof findJobStates>> extends Map<string, infer V> ? V : never
>;

export interface WorkDirSweepOptions {
  db: StudixDb;
  workDir: string;
  /** How long the scratch of a failed job stays: a retry reuses it (synchronous media outputs). */
  retentionMs: number;
  clock: Clock;
  logger: Logger;
}

/** Job scratch directories are named after the job id (`<workDir>/<jobId>`); other entries are not ours. */
const UNKNOWN_MIN_AGE_MS = 7 * 24 * 3600 * 1000;

const JOB_DIR = /^job_[A-Za-z0-9]+$/;

/**
 * Remove scratch directories no job needs any more and return how many went:
 * - jobs that ended `succeeded` or `cancelled` (finalize cleans up success, a cancel never does),
 * - `failed` jobs that finished longer ago than the retention,
 * - directories of unknown jobs untouched for longer than the retention and at least seven days.
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
  // A directory no job row explains may belong to another stack sharing this directory: keep it much longer.
  const unknownCutoff = clock.now().getTime() - Math.max(retentionMs, UNKNOWN_MIN_AGE_MS);
  const isExpired = async (id: string, job: JobState | undefined): Promise<boolean> => {
    if (!job) {
      const mtime = (await stat(join(workDir, id)).catch(() => undefined))?.mtimeMs;
      return mtime !== undefined && mtime < unknownCutoff;
    }
    if (job.status === "succeeded" || job.status === "cancelled") return true;
    return job.status === "failed" && (job.finishedAt?.getTime() ?? 0) < cutoff;
  };
  let removed = 0;
  for (const id of ids) {
    if (!(await isExpired(id, byId.get(id)))) continue;
    // The states were read before earlier removals ran, and a retry may have claimed the job since.
    const current = (await findJobStates(db, [id])).get(id);
    if (!(await isExpired(id, current))) continue;
    try {
      await rm(join(workDir, id), { recursive: true, force: true });
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
