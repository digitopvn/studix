import type { PlannerSelection, TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import type { AppDeps } from "./app-deps.ts";

/**
 * Fail fast when a new job selects a planner it cannot use: the Claude planner is off, or the connection
 * is missing, revoked, invalid or someone else's personal key. The worker checks again when it plans.
 */
export async function assertPlannerSelection(
  deps: Pick<AppDeps, "providers" | "claudePlanner">,
  ctx: TenantContext,
  planner: PlannerSelection | undefined,
): Promise<void> {
  if (!planner) return;
  if (!deps.claudePlanner || !deps.providers) {
    throw new StudixError("UNAVAILABLE", "The Claude planner is not enabled on this Studix server", {
      retryable: false,
      suggestedAction: "Omit planner to use the default planner, or ask the operator to enable it.",
    });
  }
  await deps.providers.assertUsable(ctx, planner.providerConnectionId);
}
