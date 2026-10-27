import { createHash } from "node:crypto";
import {
  type ApprovalPolicy,
  type ApprovalRepository,
  type ApprovalSubject,
  type AuditRepository,
  actorRef,
  decideFailClosed,
} from "@studix/core";
import { type Clock, StudixError } from "@studix/shared";
import type { GatewayCallContext } from "./gateway-call-context.ts";

/** Deterministic JSON (sorted keys) so equal arguments always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Approval key binding an approval to one tool and one exact set of arguments. */
export function mutationApprovalKey(qualifiedTool: string, args: Record<string, unknown>): string {
  const digest = createHash("sha256").update(canonicalJson(args)).digest("hex").slice(0, 16);
  return `${qualifiedTool}#${digest}`;
}

export interface MutationApprovalDeps {
  approvals: ApprovalRepository;
  audit: AuditRepository;
  policy: ApprovalPolicy;
  clock: Clock;
}

const CONSUMED_ACTION = "connector.approval.consumed";

/**
 * Gate a mutating downstream call on a recorded human approval (state lives in Postgres, so it survives
 * worker restarts). An approval covers exactly one tool + argument set and is consumed by one execution.
 * Returns the consumed approval id, or undefined when the policy does not require approval.
 */
export async function enforceMutationApproval(
  deps: MutationApprovalDeps,
  call: GatewayCallContext,
  qualifiedTool: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const ctx = call.tenant;
  const subject: ApprovalSubject | undefined = call.jobId
    ? { type: "job", id: call.jobId }
    : call.projectId
      ? { type: "project", id: call.projectId }
      : undefined;
  if (!subject) {
    throw new StudixError("APPROVAL_REQUIRED", `${qualifiedTool} changes data and needs a human approval`, {
      retryable: false,
      suggestedAction: "Run mutating connector tools inside a job or project so the request can be approved.",
    });
  }
  const decision = await decideFailClosed(deps.policy, ctx, { action: "connector.execute", subject });
  if (!decision.required) return undefined;

  const key = mutationApprovalKey(qualifiedTool, args);
  const page = await deps.approvals.list(ctx, { subject, limit: 100 });
  const match = page.items.find((a) => a.action === "connector.execute" && a.reason.endsWith(key));
  const now = deps.clock.now().getTime();

  const live = !match?.expiresAt || match.expiresAt.getTime() > now;
  // Only a signed-in person can clear the gate (decideApproval enforces it too; this guards old rows).
  if (match?.status === "approved" && live && match.decidedBy?.type === "user") {
    // Spend the approval before calling downstream, atomically: of two concurrent calls only one wins,
    // and an unknown downstream outcome is never replayable.
    if (await deps.approvals.consume(ctx, match.id)) {
      await deps.audit.append(ctx, {
        actor: actorRef(ctx.actor),
        action: CONSUMED_ACTION,
        subjectType: "approval",
        subjectId: match.id,
        data: { tool: qualifiedTool },
      });
      return match.id;
    }
  } else if (match?.status === "pending") {
    throw approvalRequired(qualifiedTool, match.id, decision.reason);
  } else if (match?.status === "rejected") {
    throw new StudixError("FORBIDDEN", `A reviewer rejected running ${qualifiedTool} with these arguments`, {
      retryable: false,
      details: { approvalId: match.id },
    });
  }

  const created = await deps.approvals.create(ctx, {
    action: "connector.execute",
    subject,
    reason: `${decision.reason}; execute mutating connector tool ${key}`,
    requestedBy: actorRef(ctx.actor),
  });
  throw approvalRequired(qualifiedTool, created.id, decision.reason);
}

function approvalRequired(qualifiedTool: string, approvalId: string, reason: string): StudixError {
  return new StudixError("APPROVAL_REQUIRED", `${qualifiedTool} changes data and needs a human approval`, {
    retryable: false,
    suggestedAction:
      "Approve the request in the dashboard, then call studix_tool_execute again with the same arguments.",
    details: { approvalId, reason },
  });
}
