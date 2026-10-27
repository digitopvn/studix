import type { TenantContext } from "@studix/core";
import { createManualClock, StudixError } from "@studix/shared";
import {
  type DecisionExecutionRecord,
  type DecisionProvider,
  DecisionRouter,
  type DecisionRouterOptions,
} from "../src/index.ts";

export const rateLimited = () => new StudixError("RATE_LIMITED", "slow down");
export const unavailable = () => new StudixError("UNAVAILABLE", "upstream down");
export const authFailed = () =>
  new StudixError("PROVIDER_ERROR", "bad key", { retryable: false, details: { reason: "auth" } });

/** Router wired with a manual clock, a recording sink and an instant (recorded) backoff sleep. */
export function testRouter(
  providers: DecisionProvider[],
  options: Partial<DecisionRouterOptions> = {},
): {
  router: DecisionRouter;
  clock: ReturnType<typeof createManualClock>;
  records: { ctx: TenantContext; execution: DecisionExecutionRecord }[];
  sleeps: number[];
} {
  const clock = createManualClock(Date.UTC(2026, 9, 27));
  const records: { ctx: TenantContext; execution: DecisionExecutionRecord }[] = [];
  const sleeps: number[] = [];
  const router = new DecisionRouter({
    providers,
    defaultRoute: providers.map((p) => p.id),
    clock,
    sink: { record: (ctx, execution) => void records.push({ ctx, execution }) },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
    ...options,
  });
  return { router, clock, records, sleeps };
}
