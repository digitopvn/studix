import { StudixError } from "@studix/shared";
import type { Approval, ApprovalAction, ApprovalSubject } from "../entities/review.ts";
import { decideFailClosed } from "../ports/approval-policy.ts";
import { actorRef, assertPermission, type Permission, type TenantContext } from "../tenant.ts";
import type { ResolvedStudioDeps } from "./studio-input.ts";

type Deps = ResolvedStudioDeps;

/** Permission needed to perform (not approve) an action. */
export function permissionForAction(action: ApprovalAction): Permission {
  return action === "publish" ? "publish" : "project:write";
}

/** Throw NOT_FOUND unless the subject exists inside the tenant. */
export async function assertSubjectExists(
  deps: Deps,
  ctx: TenantContext,
  subject: ApprovalSubject,
): Promise<void> {
  const found = await (async () => {
    switch (subject.type) {
      case "project":
        return deps.projects.get(ctx, subject.id);
      case "project_version":
        return deps.projects.getVersion(ctx, subject.id);
      case "job":
        return deps.jobs.get(ctx, subject.id);
      case "render":
        return deps.renders.get(ctx, subject.id);
      case "asset":
        return deps.assets.get(ctx, subject.id);
    }
  })();
  if (!found) throw new StudixError("NOT_FOUND", `${subject.type} ${subject.id} not found`);
}

export function isPendingAndLive(approval: Approval, now: Date): boolean {
  return approval.status === "pending" && (approval.expiresAt === undefined || approval.expiresAt > now);
}

/** Create a pending approval, or return the live pending one for the same subject and action. */
export async function openApproval(
  deps: Deps,
  ctx: TenantContext,
  input: { action: ApprovalAction; subject: ApprovalSubject; reason: string; estimatedCostCents?: number },
): Promise<Approval> {
  const now = deps.clock.now();
  const { approval, created } = await deps.approvals.open(ctx, {
    action: input.action,
    subject: input.subject,
    reason: input.reason,
    estimatedCostCents: input.estimatedCostCents,
    requestedBy: actorRef(ctx.actor),
    expiresAt: new Date(now.getTime() + deps.defaults.approvalTtlMs),
  });
  if (!created) return approval;
  await deps.audit.append(ctx, {
    actor: actorRef(ctx.actor),
    action: "approval.requested",
    subjectType: input.subject.type,
    subjectId: input.subject.id,
    data: { approvalId: approval.id, action: input.action, reason: input.reason },
  });
  return approval;
}

function approvalRequiredError(approval: Approval): StudixError {
  return new StudixError("APPROVAL_REQUIRED", `${approval.action} requires approval: ${approval.reason}`, {
    details: {
      approvalId: approval.id,
      action: approval.action,
      subjectType: approval.subject.type,
      subjectId: approval.subject.id,
    },
    suggestedAction: "Ask a workspace member to approve the request in the Studix dashboard, then retry.",
  });
}

/**
 * Gate a side-effecting action. Returns when the policy does not require approval or an approval was
 * granted; otherwise opens (or reuses) a pending request and throws APPROVAL_REQUIRED. Fails closed.
 */
export async function ensureActionApproved(
  deps: Deps,
  ctx: TenantContext,
  input: { action: ApprovalAction; subject: ApprovalSubject; estimatedCostCents?: number },
): Promise<{ required: boolean; approval?: Approval }> {
  assertPermission(ctx, permissionForAction(input.action));
  await assertSubjectExists(deps, ctx, input.subject);
  const requirement = await decideFailClosed(deps.approvalPolicy, ctx, input);
  if (!requirement.required) return { required: false };

  const latest = await deps.approvals.findLatest(ctx, input.subject, input.action);
  if (latest?.status === "approved" && latest.decidedBy?.type === "user")
    return { required: true, approval: latest };
  if (latest?.status === "rejected") {
    throw new StudixError("FORBIDDEN", `${input.action} was rejected by a reviewer`, {
      details: { approvalId: latest.id, comment: latest.comment },
      suggestedAction: "Address the reviewer's comment and request approval again.",
    });
  }
  const approval = await openApproval(deps, ctx, { ...input, reason: requirement.reason });
  await deps.audit.append(ctx, {
    actor: actorRef(ctx.actor),
    action: "approval.blocked",
    subjectType: input.subject.type,
    subjectId: input.subject.id,
    data: { approvalId: approval.id, action: input.action },
  });
  throw approvalRequiredError(approval);
}

/** Approve or reject a pending request and apply its effect on gated jobs. */
export async function decideApproval(
  deps: Deps,
  ctx: TenantContext,
  input: { approvalId: string; decision: "approved" | "rejected"; comment?: string },
): Promise<Approval> {
  assertPermission(ctx, "approval:decide");
  const approval = await deps.approvals.get(ctx, input.approvalId);
  if (!approval) throw new StudixError("NOT_FOUND", `approval ${input.approvalId} not found`);
  // Every approval is a human decision: an agent holding an API key must not clear its own gate.
  if (ctx.actor.type !== "user") {
    throw new StudixError("FORBIDDEN", `${approval.action} approvals must be granted by a signed-in person`, {
      suggestedAction: "Approve this request in the Studix dashboard.",
    });
  }
  const now = deps.clock.now();
  if (approval.status === "pending" && !isPendingAndLive(approval, now)) {
    await deps.approvals.decide(ctx, approval.id, { status: "expired", decidedAt: now });
    await deps.audit.append(ctx, {
      actor: actorRef(ctx.actor),
      action: "approval.expired",
      subjectType: approval.subject.type,
      subjectId: approval.subject.id,
      data: { approvalId: approval.id, action: approval.action },
    });
    throw new StudixError("CONFLICT", "approval request expired", {
      suggestedAction: "Request approval again.",
    });
  }
  const decided = await deps.approvals.decide(ctx, approval.id, {
    status: input.decision,
    decidedBy: actorRef(ctx.actor),
    decidedAt: now,
    comment: input.comment,
  });

  if (decided.subject.type === "job" && decided.action === "job.start") {
    const job = await deps.jobs.get(ctx, decided.subject.id);
    if (job?.status === "waiting_approval") {
      if (input.decision === "approved") await deps.queue.resume(ctx, job.id);
      else await deps.queue.cancel(ctx, job.id, "approval rejected");
    }
  }
  await deps.audit.append(ctx, {
    actor: actorRef(ctx.actor),
    action: `approval.${input.decision}`,
    subjectType: decided.subject.type,
    subjectId: decided.subject.id,
    data: { approvalId: decided.id, action: decided.action, comment: input.comment },
  });
  return decided;
}
