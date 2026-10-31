import type { NewRecord } from "../entities/common.ts";
import type { ActivityEvent, ProviderExecution, UsageEvent } from "../entities/telemetry.ts";
import type { TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export type NewUsageEvent = NewRecord<UsageEvent>;
export type NewProviderExecution = NewRecord<ProviderExecution>;

export interface UsageRange {
  jobId?: string;
  /** Inclusive lower bound. */
  since?: Date;
  /** Exclusive upper bound. */
  until?: Date;
}

/** True when a stored usage line was only an estimate and `incoming` carries the provider's receipt for it. */
export function receiptSupersedesEstimate(
  stored: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): boolean {
  return stored?.costSource === "estimate" && incoming?.costSource === "receipt";
}

export interface UsageRepository {
  /**
   * Idempotent on (workspace, dedupeKey): a duplicate returns the stored event with created=false.
   * One exception: a stored line whose `metadata.costSource` is "estimate" is replaced (not added to) by
   * a later line for the same key whose `costSource` is "receipt", so the real charge is what counts.
   */
  record(ctx: TenantContext, input: NewUsageEvent): Promise<{ event: UsageEvent; created: boolean }>;
  list(ctx: TenantContext, query?: PageRequest & UsageRange): Promise<Page<UsageEvent>>;
  totalCostCents(ctx: TenantContext, range?: UsageRange): Promise<number>;
  recordProviderExecution(ctx: TenantContext, input: NewProviderExecution): Promise<ProviderExecution>;
  listProviderExecutions(
    ctx: TenantContext,
    query: PageRequest & { jobId: string },
  ): Promise<Page<ProviderExecution>>;
}

export type NewActivityEvent = NewRecord<ActivityEvent>;

/** Append-only activity/trace events shown on dashboards. */
export interface ActivityRepository {
  append(ctx: TenantContext, input: NewActivityEvent): Promise<ActivityEvent>;
  list(
    ctx: TenantContext,
    query?: PageRequest & { projectId?: string; jobId?: string; traceId?: string },
  ): Promise<Page<ActivityEvent>>;
}
