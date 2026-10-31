import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * The scratch directory of a stage: `<workRoot>/<jobId>/stages/<stage>`. It is scoped to the job, not to the
 * attempt, so a retried job finds the file a synchronous media call already produced and paid for (the
 * stage journal says `completed`) instead of generating and billing it again. A stage that finishes removes
 * its own directory; the job's directory is removed when the job ends.
 */
export async function stageWorkDir(s: StageContext, stage: string): Promise<string> {
  const root = requireService(s, "workRoot");
  const dir = join(root, s.job.id, "stages", stage.replace(/[^A-Za-z0-9_-]/g, "_"));
  await mkdir(dir, { recursive: true });
  return dir;
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
