import type { UsageRepository } from "@studix/core";
import type { ProviderExecutionSink } from "@studix/decision-routing";

/** Persist every decision attempt (fallbacks and failures included) as a `provider_executions` row. */
export function createExecutionSink(
  usage: Pick<UsageRepository, "recordProviderExecution">,
): ProviderExecutionSink {
  return {
    record: async (ctx, execution) => {
      await usage.recordProviderExecution(ctx, execution);
    },
  };
}
