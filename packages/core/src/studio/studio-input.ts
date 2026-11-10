import { StudixError } from "@studix/shared";
import type { z } from "zod";
import { JOB_KINDS, type Job } from "../entities/job.ts";
import type { ApprovalAction } from "../entities/review.ts";
import type { UsageEvent } from "../entities/telemetry.ts";
import type { TenantContext } from "../tenant.ts";
import { type JobSpendDetail, toJobView, toQueueView } from "./job-view.ts";
import type { JobView, StudioDefaults, StudioServiceDeps } from "./studio-types.ts";

/** Service dependencies with defaults resolved. */
export type ResolvedStudioDeps = StudioServiceDeps & { defaults: StudioDefaults };

/** Parse boundary input or throw VALIDATION with JSON-pointer issue paths. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => ({ path: `/${i.path.join("/")}`, message: i.message }));
  throw new StudixError(
    "VALIDATION",
    `Invalid ${what}: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
    { details: { issues }, suggestedAction: `Fix the listed ${what} fields and retry.` },
  );
}

/** Project title fallback: the first line of the prompt, capped at 80 characters. */
export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/)[0]!.trim();
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 79)}…`;
}

/**
 * The approval action a parked job waits on: publish jobs park at their publish gate (opened by the worker),
 * every other job parks before it starts.
 */
function gatingAction(job: Job): ApprovalAction {
  return job.kind === JOB_KINDS.publish ? "publish" : "job.start";
}

/** Job view with stages and, for parked jobs, the approval it waits on. */
export async function loadJobView(deps: ResolvedStudioDeps, ctx: TenantContext, job: Job): Promise<JobView> {
  const stages = await deps.jobs.listStages(ctx, job.id);
  const subject = { type: "job" as const, id: job.id };
  // A stage can park on its own action (an agent overrun, a render gate): show the request that is open.
  const approval =
    job.status === "waiting_approval"
      ? ((await deps.approvals.list(ctx, { subject, status: "pending", limit: 1 })).items[0] ??
        (await deps.approvals.findLatest(ctx, subject, gatingAction(job))))
      : undefined;
  const queue =
    job.status === "queued"
      ? toQueueView(job, await deps.jobs.queueLoad(ctx, job), deps.clock.now())
      : undefined;
  return toJobView(job, stages, approval, await spendDetail(deps, ctx, job.id), queue);
}

async function spendDetail(
  deps: ResolvedStudioDeps,
  ctx: TenantContext,
  jobId: string,
): Promise<JobSpendDetail | undefined> {
  if (!deps.usage) return undefined;
  const usage: UsageEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.usage.list(ctx, { jobId, limit: 100, cursor });
    usage.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  const ids = new Set(
    usage.flatMap((u) => (typeof u.metadata?.connectionId === "string" ? [u.metadata.connectionId] : [])),
  );
  const connectionLabels = new Map<string, string>();
  for (const id of ids) {
    const connection = await deps.providerConnections?.get(ctx, id).catch(() => undefined);
    if (connection) connectionLabels.set(id, connection.label);
  }
  return { usage, connectionLabels };
}
