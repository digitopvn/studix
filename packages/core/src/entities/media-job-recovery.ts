import { StudixError } from "@studix/shared";
import type { AttachMediaJobInput } from "../ports/job-queue.ts";
import type { MediaJobRecord } from "../ports/media-provider.ts";
import type { Stage } from "./job.ts";

/** The only upstream route whose submissions leave a `submitting` intent that can be resolved by hand. */
export const RECOVERABLE_MEDIA_ROUTE = "atlas";

/** What an upstream job id may look like: it reaches the Multix CLI as an argument, so it never starts with `-`. */
export const MEDIA_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface MediaJobRecovery {
  /** The stage row that holds the record; its journal is what gets rewritten. */
  stage: Stage;
  /** The stage's records with the stuck one promoted to `submitted`. */
  records: MediaJobRecord[];
  recovered: MediaJobRecord;
}

/**
 * Pick the record a stage journal would use for the key (the newest across attempts, as the stage journal
 * reads them back) and point it at the prediction the operator found. A `submitting` record is promoted to
 * `submitted`; a `submitted` Atlas record that was never collected can be corrected, so a mistyped id does
 * not block the job for good. A completed or failed record is refused. Pure: the caller persists `records`
 * on `stage` while it holds the job locked.
 */
export function promoteSubmittingRecord(
  stages: readonly Stage[],
  input: AttachMediaJobInput,
  now: Date,
): MediaJobRecovery {
  if (!MEDIA_JOB_ID_PATTERN.test(input.predictionId)) {
    throw new StudixError("VALIDATION", "not a valid prediction id", { retryable: false });
  }
  let holder: Stage | undefined;
  let newest: MediaJobRecord | undefined;
  for (const stage of stages) {
    if (stage.name !== input.stage) continue;
    for (const record of stage.mediaJobs ?? []) {
      if (record.idempotencyKey !== input.idempotencyKey) continue;
      if (!newest || record.updatedAt >= newest.updatedAt) {
        holder = stage;
        newest = record;
      }
    }
  }
  if (!holder || !newest) {
    throw new StudixError(
      "NOT_FOUND",
      `no media job record ${input.idempotencyKey} in stage ${input.stage}`,
      { retryable: false },
    );
  }
  const correcting = newest.state === "submitted" && newest.job?.provider === RECOVERABLE_MEDIA_ROUTE;
  if (newest.state !== "submitting" && !correcting) {
    throw new StudixError("CONFLICT", `the record is ${newest.state}, not waiting for a prediction`, {
      retryable: false,
      details: { state: newest.state },
    });
  }
  // One prediction belongs to one request: attaching it to a second key would collect the same media twice.
  const taken = stages
    .flatMap((s) => s.mediaJobs ?? [])
    .some((r) => r.idempotencyKey !== newest.idempotencyKey && r.job?.id === input.predictionId);
  if (taken) {
    throw new StudixError("CONFLICT", "this prediction is already attached to another request", {
      retryable: false,
    });
  }
  // Strictly newer than every copy of the old record, whatever the clocks of the API and the worker say.
  const stamp = Math.max(now.getTime(), Date.parse(newest.updatedAt) + 1);
  const recovered: MediaJobRecord = {
    ...newest,
    job: { provider: RECOVERABLE_MEDIA_ROUTE, id: input.predictionId },
    state: "submitted",
    updatedAt: new Date(stamp).toISOString(),
  };
  // Copies of the old record sit in the rows of earlier attempts; the newest-wins read ignores them.
  const records = (holder.mediaJobs ?? []).map((r) => (r === newest ? recovered : r));
  return { stage: holder, records, recovered };
}
