import { mkdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { StudixError, toStudixError } from "@studix/shared";
import { StageFailedAfterSpend, StageSuspended } from "./stage-signals.ts";
import type { StageContext, StageServices, StageUsage } from "./workflow-types.ts";

/** A service the stage cannot run without; fails non-retryably when the worker did not wire it. */
export function requireService<K extends keyof StageServices>(
  s: StageContext,
  name: K,
): NonNullable<StageServices[K]> {
  const service = s.services[name];
  if (service === undefined) {
    throw new StudixError("UNAVAILABLE", `Stage needs the ${String(name)} service, which this worker lacks`, {
      retryable: false,
      details: { service: name, job: s.job.id },
      suggestedAction: "Configure the service for the worker (see docs/RENDERER.md and the provider docs).",
    });
  }
  return service as NonNullable<StageServices[K]>;
}

/** A fresh-or-reused scratch directory of this stage attempt: `<workRoot>/<jobId>/attempt-<n>/<stage>`. */
export async function stageWorkDir(s: StageContext, stage: string): Promise<string> {
  const root = requireService(s, "workRoot");
  const dir = join(root, s.job.id, `attempt-${s.attempt}`, stage.replace(/[^A-Za-z0-9_-]/g, "_"));
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * The directories of the earlier attempts that match `workDir` (a directory under this attempt's scratch
 * root), oldest first. Empty on the first attempt or when `workDir` is not under the attempt root.
 */
export function priorAttemptDirs(s: StageContext, workDir: string): string[] {
  const root = s.services.workRoot;
  if (root === undefined || s.attempt <= 1) return [];
  const attemptRoot = (n: number) => join(root, s.job.id, `attempt-${n}`);
  const rel = relative(attemptRoot(s.attempt), workDir);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) return [];
  return Array.from({ length: s.attempt - 1 }, (_, i) => join(attemptRoot(i + 1), rel));
}

/**
 * Run `work` over `items` with at most `limit` in flight, keeping the input order in the result. After the
 * first failure no new item starts, but the items already running are awaited, so none of their paid calls
 * goes unseen.
 *
 * With `usageOf`, the usage of every item that completed (and of every failure that carries its own, see
 * `StageFailedAfterSpend`) is billed even when the batch fails: the first failure is rethrown as a
 * `StageFailedAfterSpend` holding all of it, so the stage runner records the spend before failing the stage.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
  usageOf?: (result: R) => readonly StageUsage[],
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const completed = new Array<boolean>(items.length).fill(false);
  const errors: unknown[] = [];
  let next = 0;
  const lane = async () => {
    while (errors.length === 0 && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index] as T, index);
        completed[index] = true;
      } catch (err) {
        errors.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  const [first] = errors;
  if (errors.length === 0) return results;
  if (!usageOf) throw first;
  const usage: StageUsage[] = [];
  for (const err of errors) {
    if (err instanceof StageFailedAfterSpend || err instanceof StageSuspended) usage.push(...err.usage);
  }
  results.forEach((r, i) => {
    if (completed[i]) usage.push(...usageOf(r));
  });
  if (first instanceof StageSuspended) throw new StageSuspended(first.suspension, usage);
  if (usage.length === 0) throw first;
  throw new StageFailedAfterSpend(
    first instanceof StageFailedAfterSpend ? first.error : toStudixError(first),
    usage,
  );
}
