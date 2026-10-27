import type { BillingPolicy, SpendDecision, SpendRequest } from "@studix/core";

const isCents = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * BillingPolicy that enforces per-job budgets. No credit conversion is applied: pricing is undecided,
 * so only COGS is compared against the budget. Fails closed on malformed numbers.
 */
export function createJobBudgetPolicy(): BillingPolicy {
  return {
    async authorizeSpend(_ctx, request: SpendRequest): Promise<SpendDecision> {
      if (!isCents(request.estimatedCostCents)) {
        return { allowed: false, code: "FORBIDDEN", reason: "spend estimate is missing or invalid" };
      }
      if (request.budgetCents === undefined) return { allowed: true };
      if (!isCents(request.budgetCents)) {
        return { allowed: false, code: "FORBIDDEN", reason: "job budget is invalid" };
      }
      const spent = request.spentCents ?? 0;
      if (!isCents(spent)) {
        return { allowed: false, code: "FORBIDDEN", reason: "job spend is invalid" };
      }
      const projected = spent + request.estimatedCostCents;
      if (projected > request.budgetCents) {
        return {
          allowed: false,
          code: "BUDGET_EXCEEDED",
          reason: `${request.purpose} would bring job spend to ${projected}¢, over the ${request.budgetCents}¢ budget`,
        };
      }
      return { allowed: true };
    },
  };
}
