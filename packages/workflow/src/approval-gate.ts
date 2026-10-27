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
  /** Opens approval requests; fenced by the job owner and attempt. */
  queue: Pick<WorkerJobQueue, "requestApproval">;
  clock: Clock;
  /** Lifetime of an approval request opened by the worker. */
  approvalTtlMs: number;
}

export type ApprovalGateResult =
  | { status: "approved"; approval?: Approval }
  | { status: "waiting"; approval: Approval }
  | { status: "lease_lost" };

/**
 * Check, at execution time, whether a job may perform a gated action. State is read from the database on
 * every check, so it survives worker restarts. Only an approval decided by a signed-in human counts;
 * a rejection fails the job; otherwise a pending request is opened (or reused) and the caller parks.
 * The request and its audit entry are written through the fenced queue, so a worker that lost the job
 * opens nothing and reports `lease_lost`.
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
  const latest = await deps.approvals.findLatest(ctx, subject, gate.action);
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

  const opened = await deps.queue.requestApproval(job, workerId, {
    action: gate.action,
    reason: requirement.reason,
    estimatedCostCents: gate.estimatedCostCents,
    ttlMs: deps.approvalTtlMs,
  });
  if (opened.status === "lost") return { status: "lease_lost" };
  return { status: "waiting", approval: opened.approval };
}
