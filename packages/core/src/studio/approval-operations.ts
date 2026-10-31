import { StudixError } from "@studix/shared";
import { dependentsOf, nodeKey, type VideoIR, videoIrNodes } from "@studix/video-ir";
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

/** Close an expired pending request (audited) and throw CONFLICT: nobody can decide it any more. */
async function expireAndThrow(deps: Deps, ctx: TenantContext, approval: Approval, now: Date): Promise<never> {
  await deps.approvals.decide(ctx, approval.id, { status: "expired", decidedAt: now });
  await deps.audit.append(ctx, {
    actor: actorRef(ctx.actor),
    action: "approval.expired",
    subjectType: approval.subject.type,
    subjectId: approval.subject.id,
    data: { approvalId: approval.id, action: approval.action },
  });
  throw new StudixError("CONFLICT", "approval request expired", {
    suggestedAction:
      approval.subject.type === "job"
        ? "Submit the job again and ask a reviewer to approve it before the request expires."
        : "Request approval again.",
  });
}

/**
 * Image assets a version shows (in a shot or as a scene background): what a reviewer can ask to redo. Assets
 * kept only as history, such as a replaced design, are not.
 */
export function shownImageAssets(ir: VideoIR): Set<string> {
  const shown = new Set(
    ir.scenes.flatMap((scene) => [
      ...scene.shots.flatMap((shot) => ("assetId" in shot && shot.assetId ? [shot.assetId] : [])),
      ...(scene.background?.assetId ? [scene.background.assetId] : []),
    ]),
  );
  return new Set(ir.assets.filter((a) => a.kind === "image" && shown.has(a.id)).map((a) => a.id));
}

/** Most targets one change request may name. */
export const MAX_CHANGE_TARGETS = 20;

/**
 * Send a pending creative gate back with the assets to redo and the reviewer's note. It is not an approval
 * (the job redoes only `targets`, then asks the same gate again), so the agent that runs the job may send
 * it as well as a person. Targets must be image assets of the project's current version, which is the board
 * the gate shows; the stored `changes.invalidated` is every node of that version depending on them.
 */
export async function requestGateChanges(
  deps: Deps,
  ctx: TenantContext,
  input: { approval: Approval; targets: readonly string[]; note: string },
): Promise<Approval> {
  const { approval } = input;
  if (approval.action !== "creative.gate" || approval.subject.type !== "job") {
    throw new StudixError(
      "VALIDATION",
      `changes can only be requested on a creative gate, not ${approval.action}`,
      {
        suggestedAction: "Approve or reject this request.",
      },
    );
  }
  const note = input.note.trim();
  if (note.length === 0) {
    throw new StudixError("VALIDATION", "a change request needs a note saying what to change", {
      suggestedAction: "Describe the change in the comment.",
    });
  }
  const targets = [...new Set(input.targets)];
  if (targets.length === 0 || targets.length > MAX_CHANGE_TARGETS) {
    throw new StudixError("VALIDATION", `name between 1 and ${MAX_CHANGE_TARGETS} asset ids to redo`, {
      suggestedAction: "List the asset ids of the designs to redraw (studix_get_project with includeIr).",
    });
  }
  const now = deps.clock.now();
  if (!isPendingAndLive(approval, now)) {
    if (approval.status === "pending") await expireAndThrow(deps, ctx, approval, now);
    throw new StudixError("CONFLICT", `approval ${approval.id} is already ${approval.status}`);
  }
  const job = await deps.jobs.get(ctx, approval.subject.id);
  if (!job?.projectId) throw new StudixError("NOT_FOUND", `job ${approval.subject.id} has no project`);
  const project = await deps.projects.get(ctx, job.projectId);
  const version = project?.currentVersionId
    ? await deps.projects.getVersion(ctx, project.currentVersionId)
    : undefined;
  if (!version) throw new StudixError("CONFLICT", `project ${job.projectId} has no version to revise`);
  const images = shownImageAssets(version.ir);
  const unknown = targets.filter((t) => !images.has(t));
  if (unknown.length > 0) {
    throw new StudixError("VALIDATION", `not an image shown on the reviewed version: ${unknown.join(", ")}`, {
      details: { unknown, versionId: version.id },
      suggestedAction: "Call studix_get_project with includeIr to list the board's asset ids.",
    });
  }
  const invalidated = [...dependentsOf(videoIrNodes(version.ir), targets.map(nodeKey.asset))].sort();
  const decided = await deps.approvals.decide(ctx, approval.id, {
    status: "changes_requested",
    decidedBy: actorRef(ctx.actor),
    decidedAt: now,
    comment: note,
    changes: { targets, note, invalidated },
  });
  await deps.audit.append(ctx, {
    actor: actorRef(ctx.actor),
    action: "approval.changes_requested",
    subjectType: decided.subject.type,
    subjectId: decided.subject.id,
    data: {
      approvalId: decided.id,
      action: decided.action,
      versionId: version.id,
      targets,
      invalidated,
      note,
    },
  });
  return decided;
}

/**
 * Decide a pending request and apply its effect on gated jobs: approve or reject it, or, on a creative gate,
 * request changes to named assets (see requestGateChanges). Always a signed-in person here.
 */
export async function decideApproval(
  deps: Deps,
  ctx: TenantContext,
  input: {
    approvalId: string;
    decision: "approved" | "rejected" | "changes_requested";
    comment?: string;
    targets?: string[];
  },
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
  if (input.decision === "changes_requested") {
    return requestGateChanges(deps, ctx, {
      approval,
      targets: input.targets ?? [],
      note: input.comment ?? "",
    });
  }
  if (input.targets !== undefined) {
    throw new StudixError("VALIDATION", "targets are only allowed with decision changes_requested");
  }
  const now = deps.clock.now();
  if (approval.status === "pending" && !isPendingAndLive(approval, now)) {
    await expireAndThrow(deps, ctx, approval, now);
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
