import { type Approval, type ApprovalAction, type ApprovalPolicy, decideFailClosed } from "@studix/core";
import { StudixError } from "@studix/shared";

/** The action a QA human review approves: the final render, after its hard gate passed. */
export const QA_REVIEW_ACTION: ApprovalAction = "render.final";

export interface QaApprovalPolicyOptions {
  /** Actions that always need a person after QA, whatever their cost. Defaults to the final render. */
  actions?: readonly ApprovalAction[];
}

/**
 * The human layer of QA as an ApprovalPolicy: the reviewed actions always require a human approval, regardless of
 * cost or of what the wrapped policy says; every other action is decided by `base`, failing closed.
 */
export function createQaApprovalPolicy(
  base: ApprovalPolicy,
  options: QaApprovalPolicyOptions = {},
): ApprovalPolicy {
  const reviewed: ReadonlySet<ApprovalAction> = new Set(options.actions ?? [QA_REVIEW_ACTION]);
  if (reviewed.size === 0) throw new RangeError("a QA approval policy needs at least one reviewed action");
  return {
    async decide(ctx, check) {
      if (reviewed.has(check.action)) {
        return { required: true, reason: `QA human review: a person must approve ${check.action}` };
      }
      return decideFailClosed(base, ctx, check);
    },
  };
}

export type HumanReviewVerdict =
  | { approved: true; approval: Approval }
  | {
      approved: false;
      reason: "missing" | "pending" | "rejected" | "expired" | "not_human" | "wrong_action" | "wrong_subject";
    };

/**
 * Whether an approval is a human sign-off for `action` on `subject`: approved and decided by a signed-in user (an agent
 * or system decision never counts). Used by the review stage as a second check after the
 * engine's approval gate, so a permissive policy cannot waive the human layer.
 */
export function humanReviewVerdict(
  approval: Approval | undefined,
  expected: { action: ApprovalAction; subject: Approval["subject"] },
): HumanReviewVerdict {
  if (!approval) return { approved: false, reason: "missing" };
  if (approval.action !== expected.action) return { approved: false, reason: "wrong_action" };
  if (approval.subject.type !== expected.subject.type || approval.subject.id !== expected.subject.id)
    return { approved: false, reason: "wrong_subject" };
  if (approval.status === "rejected") return { approved: false, reason: "rejected" };
  if (approval.status === "expired") return { approved: false, reason: "expired" };
  if (approval.status !== "approved") return { approved: false, reason: "pending" };
  if (approval.decidedBy?.type !== "user") return { approved: false, reason: "not_human" };
  return { approved: true, approval };
}

/** Throw FORBIDDEN unless the verdict is a human approval. */
export function assertHumanReview(verdict: HumanReviewVerdict): Approval {
  if (verdict.approved) return verdict.approval;
  throw new StudixError("FORBIDDEN", `QA human review is required (${verdict.reason.replace("_", " ")})`, {
    retryable: false,
    details: { reason: verdict.reason },
    suggestedAction: "A signed-in reviewer approves the render in the dashboard, then the job resumes.",
  });
}
