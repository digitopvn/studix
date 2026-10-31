import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { StudixError } from "@studix/shared";
import type { StageContext, StageServices } from "./workflow-types.ts";

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
 * Run `work` over `items` with at most `limit` in flight, keeping the input order in the result. The first
 * failure rejects; items not yet started are not started.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index] as T, index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}
