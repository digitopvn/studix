import { StudixError } from "@studix/shared";
import type { z } from "zod";
import type { Job } from "../entities/job.ts";
import type { TenantContext } from "../tenant.ts";
import { toJobView } from "./job-view.ts";
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

/** Job view with stages and, for parked jobs, the approval it waits on. */
export async function loadJobView(deps: ResolvedStudioDeps, ctx: TenantContext, job: Job): Promise<JobView> {
  const stages = await deps.jobs.listStages(ctx, job.id);
  const approval =
    job.status === "waiting_approval"
      ? await deps.approvals.findLatest(ctx, { type: "job", id: job.id }, "job.start")
      : undefined;
  return toJobView(job, stages, approval);
}
