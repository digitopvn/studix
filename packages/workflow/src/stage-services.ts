import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { StudixError, toStudixError } from "@studix/shared";
import { StageFailedAfterSpend } from "./stage-signals.ts";
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

/** Options of {@link mapBounded}. */
export interface MapBoundedOptions<R> {
  /**
   * The usage lines carried by one completed result. When set and a sibling fails, the spend of every
   * completed item (and of items that were still running) is billed through `StageFailedAfterSpend`
   * instead of being dropped with the batch.
   */
  usageOf?: (result: R) => readonly StageUsage[];
}

/**
 * Run `work` over `items` with at most `limit` in flight, keeping the input order in the result. After the
 * first failure no further item starts; items already running are awaited so their spend is not lost, then
 * the first failure rejects (as `StageFailedAfterSpend` when `usageOf` found spend to bill).
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
  options: MapBoundedOptions<R> = {},
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const done = new Array<boolean>(items.length).fill(false);
  const failures: unknown[] = [];
  let next = 0;
  const lane = async () => {
    while (failures.length === 0 && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index] as T, index);
        done[index] = true;
      } catch (err) {
        failures.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failures.length === 0) return results;

  const first = failures[0];
  const { usageOf } = options;
  if (!usageOf) throw first;
  const usage: StageUsage[] = [];
  for (const failure of failures) if (failure instanceof StageFailedAfterSpend) usage.push(...failure.usage);
  results.forEach((result, index) => {
    if (done[index]) usage.push(...usageOf(result));
  });
  if (usage.length === 0) throw first;
  throw new StageFailedAfterSpend(
    first instanceof StageFailedAfterSpend ? first.error : toStudixError(first),
    usage,
  );
}
