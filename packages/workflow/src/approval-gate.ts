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
  /** A reviewer sent a creative gate back with assets to redo; the stage redoes them and asks again. */
  | { status: "changes_requested"; approval: Approval }
  | { status: "lease_lost" };

/**
 * The gate's answer when `latest` is already settled (granted, rejected, sent back with changes, or still
 * pending); else undefined.
 */
function settle(
  action: ApprovalAction,
  latest: Approval | undefined,
  now: Date,
): ApprovalGateResult | undefined {
  if (latest?.status === "approved" && latest.decidedBy?.type === "user") {
    return { status: "approved", approval: latest };
  }
  if (latest?.status === "rejected") {
    throw new StudixError("FORBIDDEN", `${action} was rejected by a reviewer`, {
      retryable: false,
      details: { approvalId: latest.id, comment: latest.comment },
      suggestedAction: "Address the reviewer's comment and submit a new job.",
    });
  }
  if (latest?.status === "changes_requested" && latest.changes) {
    return { status: "changes_requested", approval: latest };
  }
  if (latest?.status === "pending" && (latest.expiresAt === undefined || latest.expiresAt > now)) {
    return { status: "waiting", approval: latest };
  }
  return undefined;
}

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
  gate: {
    action: ApprovalAction;
    estimatedCostCents?: number;
    /** Scope of the gate (e.g. `gate:G1`); without it the latest request of the action, any scope, counts. */
    scopeKey?: string;
    /** What the reviewer is asked to sign off; prefixed to the policy's reason. */
    reason?: string;
  },
): Promise<ApprovalGateResult> {
  const subject = { type: "job" as const, id: job.id };
  const requirement = await decideFailClosed(deps.approvalPolicy, ctx, {
    action: gate.action,
    subject,
    estimatedCostCents: gate.estimatedCostCents,
  });
  if (!requirement.required) return { status: "approved" };

  const now = deps.clock.now();
  const latest = await deps.approvals.findLatest(ctx, subject, gate.action, gate.scopeKey);
  const settled = settle(gate.action, latest, now);
  if (settled) return settled;

  const opened = await deps.queue.requestApproval(job, workerId, {
    action: gate.action,
    reason: gate.reason ? `${gate.reason} (${requirement.reason})` : requirement.reason,
    estimatedCostCents: gate.estimatedCostCents,
    ttlMs: deps.approvalTtlMs,
    ...(gate.scopeKey ? { scopeKey: gate.scopeKey } : {}),
  });
  if (opened.status === "lost") return { status: "lease_lost" };
  if (opened.status === "decided") return settle(gate.action, opened.approval, now)!;
  return { status: "waiting", approval: opened.approval };
}
