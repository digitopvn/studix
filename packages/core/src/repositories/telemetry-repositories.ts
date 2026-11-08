import { redact } from "@studix/shared";
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

/** Events a retention sweep must keep: the job chat is a record users read back, not runtime noise. */
export const ACTIVITY_RETENTION_KEEP_NAMES: readonly string[] = ["agent.event"];

/**
 * Derives the short text a log line shows when the writer gave none: the event's own `attributes.message` (or
 * `text`, `name`, `error`, `delta`, `status`) prefixed by its `type`. Truncated and redacted; never throws.
 */
export function deriveActivityMessage(attributes: Record<string, unknown>): string | undefined {
  const text = (key: string): string | undefined => {
    const v = attributes[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const body =
    text("message") ?? text("text") ?? text("name") ?? text("error") ?? text("delta") ?? text("status");
  const type = text("type");
  const line = [type && type !== body ? type : undefined, body].filter(Boolean).join(": ");
  if (!line) return undefined;
  const flat = redact(line).replace(/\s+/g, " ");
  return flat.length > ACTIVITY_MESSAGE_CHARS ? `${flat.slice(0, ACTIVITY_MESSAGE_CHARS)}…` : flat;
}
const ACTIVITY_MESSAGE_CHARS = 240;

/** Append-only activity/trace events shown on dashboards. */
export interface ActivityRepository {
  append(ctx: TenantContext, input: NewActivityEvent): Promise<ActivityEvent>;
  list(
    ctx: TenantContext,
    query?: PageRequest & { projectId?: string; jobId?: string; traceId?: string },
  ): Promise<Page<ActivityEvent>>;
  /** Events in a time window, oldest first by id, at most `limit`, always inside the context's workspace. */
  window(ctx: TenantContext, query: ActivityWindowQuery): Promise<ActivityEvent[]>;
  /**
   * Platform maintenance, not tenant-scoped: deletes up to `limit` events created before `before`, except those
   * whose name is in `keepNames`. Returns how many were removed; call again until it returns less than `limit`.
   */
  purgeBefore(before: Date, options: { limit: number; keepNames?: readonly string[] }): Promise<number>;
  /** A job's events with one name, oldest first, strictly after `afterId` (the replay offset). */
  listAfter(
    ctx: TenantContext,
    query: { jobId: string; name: string; afterId?: string; limit?: number },
  ): Promise<ActivityEvent[]>;
}
