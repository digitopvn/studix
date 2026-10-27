import type { TenantContext } from "../tenant.ts";

export interface SpendRequest {
  jobId?: string;
  /** What the money is for (e.g. "render", "model.call", "media.generate"). */
  purpose: string;
  estimatedCostCents: number;
  /** Job budget limit and amount already spent, when the spend is inside a job. */
  budgetCents?: number;
  spentCents?: number;
}

export type SpendDecision =
  | { allowed: true }
  | { allowed: false; reason: string; code: "BUDGET_EXCEEDED" | "APPROVAL_REQUIRED" | "FORBIDDEN" };

/** Decides whether a cost may be incurred (credits, plan limits, job budgets). Must fail closed. */
export interface BillingPolicy {
  authorizeSpend(ctx: TenantContext, request: SpendRequest): Promise<SpendDecision>;
}
