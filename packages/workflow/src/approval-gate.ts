import {
  type Approval,
  type ApprovalAction,
  type ApprovalPolicy,
  type ApprovalRepository,
  decideFailClosed,
  type Job,
  type TenantContext,
} from "@studix/core";
import { type Clock, StudixError } from "@studix/shared";
import type { WorkerJobQueue } from "./worker-job-queue.ts";

export interface ApprovalGateDeps {
  approvalPolicy: ApprovalPolicy;
  approvals: ApprovalRepository;
  /** Opens approvals; the request and its audit entry are written fenced by job owner and attempt. */
  queue: Pick<WorkerJobQueue, "openApproval">;
  clock: Clock;
  /** Lifetime of an approval request opened by the worker. */
  approvalTtlMs: number;
}

export type ApprovalGateResult =
  | { status: "approved"; approval?: Approval }
  | { status: "waiting"; approval: Approval }
  /** The job was reclaimed by another worker; nothing was written. */
  | { status: "lease_lost" };

/**
 * Check, at execution time, whether a job may perform a gated action. State is read from the database on
 * every check, so it survives worker restarts. Only an approval decided by a signed-in human counts;
 * a rejection fails the job; otherwise a pending request is opened (or reused) and the caller parks.
 */
export async function checkApprovalGate(
  deps: ApprovalGateDeps,
  ctx: TenantContext,
  job: Job,
  workerId: string,
  gate: { action: ApprovalAction; estimatedCostCents?: number },
): Promise<ApprovalGateResult> {
  const subject = { type: "job" as const, id: job.id };
  const requirement = await decideFailClosed(deps.approvalPolicy, ctx, {
    action: gate.action,
    subject,
    estimatedCostCents: gate.estimatedCostCents,
  });
  if (!requirement.required) return { status: "approved" };

  const now = deps.clock.now();
  const settle = (latest: Approval | undefined): ApprovalGateResult | undefined => {
    if (latest?.status === "approved" && latest.decidedBy?.type === "user") {
      return { status: "approved", approval: latest };
    }
    if (latest?.status === "rejected") {
      throw new StudixError("FORBIDDEN", `${gate.action} was rejected by a reviewer`, {
        retryable: false,
        details: { approvalId: latest.id, comment: latest.comment },
        suggestedAction: "Address the reviewer's comment and submit a new job.",
      });
    }
    if (latest?.status === "pending" && (latest.expiresAt === undefined || latest.expiresAt > now)) {
      return { status: "waiting", approval: latest };
    }
    return undefined;
  };

  const settled = settle(await deps.approvals.findLatest(ctx, subject, gate.action));
  if (settled) return settled;

  // The reads above are unfenced and may be stale; openApproval re-checks under the job lock and
  // returns the approval that already exists instead of opening a second one.
  const opened = await deps.queue.openApproval(job, workerId, {
    action: gate.action,
    reason: requirement.reason,
    estimatedCostCents: gate.estimatedCostCents,
    expiresAt: new Date(now.getTime() + deps.approvalTtlMs),
  });
  if (!opened) return { status: "lease_lost" };
  return settle(opened) ?? { status: "waiting", approval: opened };
}
