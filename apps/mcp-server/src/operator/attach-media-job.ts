import type { JobView, MediaJobRecord, StudioService, TenantContext } from "@studix/core";
import type { DatabaseHandle } from "@studix/database";
import { StudixError, toStudixError } from "@studix/shared";

export interface OperatorAttachInput {
  jobId: string;
  stage: string;
  idempotencyKey: string;
  predictionId: string;
  /** Who runs the recovery; recorded as the system actor `operator:<name>` on the audit events. */
  operator: string;
  /** Requeue the job after attaching so a worker collects the prediction (default true). */
  retry?: boolean;
}

export interface OperatorAttachResult {
  job: JobView;
  mediaJob: MediaJobRecord;
  /** Set when the attach committed but the retry failed: retry the job itself (`studix_retry_job`). */
  retryError?: { code: string; message: string };
}

/**
 * Platform operator recovery of an Atlas call stuck in "submitting": attach the prediction found in
 * `multix history` or the Atlas Cloud console to the job's own workspace, then retry the job. This runs as a
 * system actor because `job:recover` is never granted to a workspace: the prediction id is trusted as given
 * and collected with the platform's provider key, so only someone who checked it against Atlas may attach it.
 */
export async function attachMediaJobAsOperator(
  deps: { client: DatabaseHandle["client"]; studio: StudioService },
  input: OperatorAttachInput,
): Promise<OperatorAttachResult> {
  const operator = input.operator.trim();
  if (!/^[\w.@-]{1,64}$/.test(operator)) {
    throw new StudixError("VALIDATION", "operator must be 1-64 letters, digits, '.', '_', '@' or '-'");
  }
  // Deliberately unscoped: the operator works across workspaces and the job id names the tenant.
  const rows = await deps.client<{ organization_id: string; workspace_id: string }[]>`
    select organization_id, workspace_id from jobs where id = ${input.jobId}`;
  const owner = rows[0];
  if (!owner) throw new StudixError("NOT_FOUND", `job ${input.jobId} not found`);
  const ctx: TenantContext = {
    organizationId: owner.organization_id,
    workspaceId: owner.workspace_id,
    actor: { type: "system", id: `operator:${operator}` },
  };
  const attached = await deps.studio.attachMediaJob(ctx, {
    jobId: input.jobId,
    stage: input.stage,
    idempotencyKey: input.idempotencyKey,
    predictionId: input.predictionId,
  });
  if (input.retry === false) return attached;
  try {
    return { job: await deps.studio.retryJob(ctx, input.jobId), mediaJob: attached.mediaJob };
  } catch (error) {
    // The attach is committed and cannot run twice; report it with the retry error instead of losing it.
    const err = toStudixError(error);
    return { ...attached, retryError: { code: err.code, message: err.message } };
  }
}
