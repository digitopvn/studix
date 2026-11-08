import type { NewRecord } from "../entities/common.ts";
import type { ActivityEvent, ActivityLevel, ProviderExecution, UsageEvent } from "../entities/telemetry.ts";
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

export interface UsageRepository {
  /**
   * Idempotent on (workspace, dedupeKey): a duplicate returns the stored event with created=false. The one
   * exception: a stored `metadata.costSource: "estimate"` is replaced by a duplicate whose
   * `metadata.costSource` is `"receipt"` (same job, real cost; not added), also created=false.
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

/**
 * Filters of an activity listing. `cursor` is the id of the last event seen: newest first it pages to older
 * events, with `order: "asc"` it pages to newer ones.
 */
export interface ActivityFilter {
  projectId?: string;
  jobId?: string;
  traceId?: string;
  /** Inclusive lower bound on the event time. */
  since?: Date;
  /** Inclusive upper bound on the event time. */
  until?: Date;
  /** Events at this level or more severe. */
  minLevel?: ActivityLevel;
  /** Case-insensitive substring of the event name, message or stored attributes. */
  search?: string;
  order?: "asc" | "desc";
}

export type NewActivityEvent = NewRecord<ActivityEvent>;

/** Append-only activity/trace events shown on dashboards. */
export interface ActivityRepository {
  append(ctx: TenantContext, input: NewActivityEvent): Promise<ActivityEvent>;
  list(ctx: TenantContext, query?: PageRequest & ActivityFilter): Promise<Page<ActivityEvent>>;
  /** A job's events with one name, oldest first, strictly after `afterId` (the replay offset). */
  listAfter(
    ctx: TenantContext,
    query: { jobId: string; name: string; afterId?: string; limit?: number },
  ): Promise<ActivityEvent[]>;
}
