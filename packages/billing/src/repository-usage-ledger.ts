import type { TenantContext, UsageEvent, UsageRepository } from "@studix/core";
import { createUsageRepository, type StudixDb } from "@studix/database";
import { type Clock, systemClock } from "@studix/shared";
import { assertValidUsage, type UsageLedger } from "./usage-ledger.ts";

const PAGE = 100;

/**
 * Usage ledger over any UsageRepository. Idempotency comes from the repository contract
 * (unique `(workspace, dedupeKey)`), so concurrent retries cannot double-count.
 */
export function createUsageLedger(usage: UsageRepository): UsageLedger {
  return {
    async record(ctx, input) {
      assertValidUsage(input);
      return usage.record(ctx, {
        dedupeKey: input.dedupeKey,
        kind: input.kind,
        quantity: input.quantity,
        unit: input.unit,
        costCents: input.costCents,
        jobId: input.jobId,
        providerExecutionId: input.providerExecutionId,
        ...(input.funding ? { funding: input.funding } : {}),
        metadata: input.metadata,
      });
    },

    jobCostCents(ctx: TenantContext, jobId: string) {
      return usage.totalCostCents(ctx, { jobId });
    },

    async listForJob(ctx, jobId) {
      const events: UsageEvent[] = [];
      let cursor: string | undefined;
      do {
        const page = await usage.list(ctx, { jobId, limit: PAGE, cursor });
        events.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return events.reverse();
    },
  };
}

/** Ledger backed by the Postgres `usage_events` table. */
export function createPostgresUsageLedger(db: StudixDb, clock: Clock = systemClock): UsageLedger {
  return createUsageLedger(createUsageRepository(db, clock));
}
