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

export type NewActivityEvent = NewRecord<ActivityEvent>;

/** A bounded, filtered read of activity events for log queries. */
export interface ActivityWindowQuery {
  /** Inclusive lower bound on `createdAt`. */
  from: Date;
  /** Inclusive upper bound on `createdAt`. */
  to: Date;
  /** Only these levels. */
  levels?: readonly ActivityEvent["level"][];
  projectId?: string;
  jobId?: string;
  traceId?: string;
  /** Case-insensitive substring of the event name or message (wildcards are literal). */
  search?: string;
  /** Strictly after this event id (the resume offset). */
  afterId?: string;
  limit: number;
}

/** Append-only activity/trace events shown on dashboards. */
export interface ActivityRepository {
  append(ctx: TenantContext, input: NewActivityEvent): Promise<ActivityEvent>;
  list(
    ctx: TenantContext,
    query?: PageRequest & { projectId?: string; jobId?: string; traceId?: string },
  ): Promise<Page<ActivityEvent>>;
  /** Events in a time window, oldest first by id, at most `limit`, always inside the context's workspace. */
  window(ctx: TenantContext, query: ActivityWindowQuery): Promise<ActivityEvent[]>;
  /** A job's events with one name, oldest first, strictly after `afterId` (the replay offset). */
  listAfter(
    ctx: TenantContext,
    query: { jobId: string; name: string; afterId?: string; limit?: number },
  ): Promise<ActivityEvent[]>;
}
