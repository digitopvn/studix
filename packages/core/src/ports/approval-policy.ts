import type { ApprovalAction, ApprovalSubject } from "../entities/review.ts";
import type { TenantContext } from "../tenant.ts";

export interface ApprovalCheck {
  action: ApprovalAction;
  subject: ApprovalSubject;
  /** Estimated cost of the action; missing estimates are treated as unknown (fail closed). */
  estimatedCostCents?: number;
}

export interface ApprovalRequirement {
  required: boolean;
  reason: string;
}

/** Decides whether an action needs a human approval. Implementations must fail closed. */
export interface ApprovalPolicy {
  decide(ctx: TenantContext, check: ApprovalCheck): Promise<ApprovalRequirement>;
}

export interface DefaultApprovalPolicyOptions {
  /** Actions estimated above this many cents need approval. */
  costThresholdCents: number;
}

/** Actions that always need a human, regardless of cost. */
const ALWAYS_REQUIRED: ReadonlySet<ApprovalAction> = new Set([
  "publish",
  "delete",
  "agent.overrun",
  "creative.gate",
]);
/** Actions gated only by cost. */
const COST_GATED: ReadonlySet<ApprovalAction> = new Set([
  "job.start",
  "render.final",
  "provider.spend",
  "connector.execute",
]);

/**
 * Baseline policy: publishing and deletion always require approval; cost-bearing actions require it
 * above the threshold or when the cost is unknown; anything unrecognised requires approval.
 */
export function createDefaultApprovalPolicy(options: DefaultApprovalPolicyOptions): ApprovalPolicy {
  if (!Number.isInteger(options.costThresholdCents) || options.costThresholdCents < 0) {
    throw new RangeError("costThresholdCents must be a non-negative integer");
  }
  return {
    async decide(_ctx, check) {
      if (ALWAYS_REQUIRED.has(check.action)) {
        return { required: true, reason: `${check.action} always requires human approval` };
      }
      if (!COST_GATED.has(check.action)) {
        return { required: true, reason: `unknown action ${String(check.action)} requires approval` };
      }
      const cost = check.estimatedCostCents;
      if (cost === undefined || !Number.isFinite(cost) || cost < 0) {
        return { required: true, reason: `${check.action} has no cost estimate` };
      }
      if (cost > options.costThresholdCents) {
        return {
          required: true,
          reason: `${check.action} estimated at ${cost}¢ exceeds the ${options.costThresholdCents}¢ approval threshold`,
        };
      }
      return { required: false, reason: "within approval threshold" };
    },
  };
}

/** Run a policy and treat any failure or malformed answer as "approval required". */
export async function decideFailClosed(
  policy: ApprovalPolicy,
  ctx: TenantContext,
  check: ApprovalCheck,
): Promise<ApprovalRequirement> {
  try {
    const result = await policy.decide(ctx, check);
    if (result && typeof result.required === "boolean") return result;
    return { required: true, reason: "approval policy returned an invalid decision" };
  } catch (err) {
    return {
      required: true,
      reason: `approval policy failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
