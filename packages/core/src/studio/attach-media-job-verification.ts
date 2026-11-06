import { StudixError } from "@studix/shared";
import { latestMediaJobRecord } from "../ports/job-queue.ts";
import type { TenantContext } from "../tenant.ts";
import type { ResolvedStudioDeps } from "./studio-input.ts";
import type { AttachMediaJobRequest } from "./studio-types.ts";

/** Upstream and worker clocks disagree a little; a prediction created this much before submit still counts. */
export const ATTACH_CLOCK_SKEW_MS = 2 * 60_000;

/**
 * Check an Atlas prediction against the "submitting" record it is about to fill: the upstream must know it,
 * it must run the record's model, and it must have been created after the record was submitted. Every
 * mismatch raises the same error, so a caller cannot probe which predictions exist or what they ran.
 *
 * This narrows, but cannot close, cross-tenant attaches: Atlas runs every tenant's calls on the platform's
 * one key, so nothing upstream says which workspace a prediction belongs to. `job:recover` is therefore
 * held only by platform operators.
 */
export async function verifyAttachableProviderJob(
  deps: Pick<ResolvedStudioDeps, "jobs" | "providerJobs">,
  ctx: TenantContext,
  input: AttachMediaJobRequest,
): Promise<void> {
  if (!deps.providerJobs) {
    throw new StudixError("UNAVAILABLE", "media job attachment is not configured", {
      retryable: false,
      suggestedAction: "Run the app with MULTIX_BIN set so the prediction can be checked with Atlas.",
    });
  }
  const record = latestMediaJobRecord(await deps.jobs.listStages(ctx, input.jobId), input);
  // No record or a record that is not waiting for an id: the queue reports that with its own error.
  if (record?.state !== "submitting") return;
  const info = await deps.providerJobs.inspectJob({ provider: "atlas", id: input.predictionId });
  const createdAt = info?.createdAt ? Date.parse(info.createdAt) : Number.NaN;
  const matches =
    info !== undefined &&
    info.model === record.model.replace(/^atlas:/, "") &&
    Number.isFinite(createdAt) &&
    createdAt >= Date.parse(record.submittedAt) - ATTACH_CLOCK_SKEW_MS;
  if (!matches) {
    throw new StudixError(
      "VALIDATION",
      `prediction ${input.predictionId} does not match media job ${input.idempotencyKey}`,
      {
        retryable: false,
        suggestedAction:
          "Attach the prediction this call submitted: same model, created after the call was submitted.",
      },
    );
  }
}
