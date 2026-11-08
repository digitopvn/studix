import {
  ACTIVITY_LEVELS,
  type ActivityEvent,
  type ActivityLevel,
  type ActivityRepository,
  type ProviderExecution,
  type TenantContext,
  type UsageEvent,
  type UsageRange,
  type UsageRepository,
} from "@studix/core";
import { type Clock, newId, redactDeep, StudixError } from "@studix/shared";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, type SQL, sql, sum } from "drizzle-orm";
import type { DbExecutor, StudixDb } from "../client.ts";
import { activityEvents, providerExecutions, usageEvents } from "../schema/telemetry.ts";
import { beforeCursor, first, opt, pageLimit, scoped, tenantValues, toPage } from "./helpers.ts";

function toUsage(row: typeof usageEvents.$inferSelect): UsageEvent {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    dedupeKey: row.dedupeKey,
    kind: row.kind,
    quantity: row.quantity,
    unit: row.unit,
    costCents: row.costCents,
    jobId: opt(row.jobId),
    providerExecutionId: opt(row.providerExecutionId),
    funding: row.funding,
    metadata: opt(row.metadata),
    createdAt: row.createdAt,
  };
}

function toExecution(row: typeof providerExecutions.$inferSelect): ProviderExecution {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    jobId: opt(row.jobId),
    stageId: opt(row.stageId),
    provider: row.provider,
    model: opt(row.model),
    operation: row.operation,
    status: row.status,
    latencyMs: row.latencyMs,
    inputTokens: opt(row.inputTokens),
    outputTokens: opt(row.outputTokens),
    costCents: row.costCents,
    attempt: row.attempt,
    error: opt(row.error),
    funding: row.funding,
    externalId: opt(row.externalId),
    createdAt: row.createdAt,
  };
}

function usageRange(ctx: TenantContext, range: UsageRange): SQL {
  return scoped(
    usageEvents,
    ctx,
    range.jobId ? eq(usageEvents.jobId, range.jobId) : undefined,
    range.since ? gte(usageEvents.createdAt, range.since) : undefined,
    range.until ? lt(usageEvents.createdAt, range.until) : undefined,
  );
}

function isReceipt(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.costSource === "receipt";
}

export function createUsageRepository(db: DbExecutor, clock: Clock): UsageRepository {
  return {
    async record(ctx, input) {
      const inserted = await db
        .insert(usageEvents)
        .values({
          id: input.id ?? newId("use"),
          ...tenantValues(ctx),
          dedupeKey: input.dedupeKey,
          kind: input.kind,
          quantity: input.quantity,
          unit: input.unit,
          costCents: input.costCents,
          jobId: input.jobId ?? null,
          providerExecutionId: input.providerExecutionId ?? null,
          funding: input.funding ?? "operator",
          metadata: input.metadata ?? null,
          createdAt: clock.now(),
        })
        .onConflictDoNothing({ target: [usageEvents.workspaceId, usageEvents.dedupeKey] })
        .returning();
      if (inserted[0]) return { event: toUsage(inserted[0]), created: true };
      // The first write was an estimate and this one is the provider's receipt: the receipt replaces it
      // (never adds to it). The condition keeps this atomic, and a receipt is never overwritten.
      if (isReceipt(input.metadata)) {
        const upgraded = await db
          .update(usageEvents)
          .set({
            kind: input.kind,
            quantity: input.quantity,
            unit: input.unit,
            costCents: input.costCents,
            metadata: input.metadata ?? null,
          })
          .where(
            scoped(
              usageEvents,
              ctx,
              and(
                eq(usageEvents.dedupeKey, input.dedupeKey),
                sql`${usageEvents.metadata}->>'costSource' = 'estimate'`,
              ),
            ),
          )
          .returning();
        if (upgraded[0]) return { event: toUsage(upgraded[0]), created: false };
      }
      const rows = await db
        .select()
        .from(usageEvents)
        .where(scoped(usageEvents, ctx, eq(usageEvents.dedupeKey, input.dedupeKey)));
      if (!rows[0]) throw new StudixError("CONFLICT", "usage dedupe key belongs to another tenant");
      return { event: toUsage(rows[0]), created: false };
    },
    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(usageEvents)
        .where(and(usageRange(ctx, query), beforeCursor(usageEvents.id, query.cursor)))
        .orderBy(desc(usageEvents.id))
        .limit(limit + 1);
      return toPage(rows.map(toUsage), limit);
    },
    async totalCostCents(ctx, range = {}) {
      const [row] = await db
        .select({ total: sum(usageEvents.costCents).mapWith(Number) })
        .from(usageEvents)
        .where(usageRange(ctx, range));
      return row?.total ?? 0;
    },
    async recordProviderExecution(ctx, input) {
      const rows = await db
        .insert(providerExecutions)
        .values({
          id: input.id ?? newId("pex"),
          ...tenantValues(ctx),
          jobId: input.jobId ?? null,
          stageId: input.stageId ?? null,
          provider: input.provider,
          model: input.model ?? null,
          operation: input.operation,
          status: input.status,
          latencyMs: input.latencyMs,
          inputTokens: input.inputTokens ?? null,
          outputTokens: input.outputTokens ?? null,
          costCents: input.costCents,
          attempt: input.attempt,
          error: input.error ? redactDeep(input.error) : null,
          funding: input.funding ?? "operator",
          externalId: input.externalId ?? null,
          createdAt: clock.now(),
        })
        .returning();
      return toExecution(first(rows, "provider execution"));
    },
    async listProviderExecutions(ctx, query) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(providerExecutions)
        .where(
          scoped(
            providerExecutions,
            ctx,
            eq(providerExecutions.jobId, query.jobId),
            beforeCursor(providerExecutions.id, query.cursor),
          ),
        )
        .orderBy(desc(providerExecutions.id))
        .limit(limit + 1);
      return toPage(rows.map(toExecution), limit);
    },
  };
}

function toActivity(row: typeof activityEvents.$inferSelect): ActivityEvent {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    name: row.name,
    level: row.level,
    message: opt(row.message),
    projectId: opt(row.projectId),
    jobId: opt(row.jobId),
    stage: opt(row.stage),
    provider: opt(row.provider),
    model: opt(row.model),
    traceId: opt(row.traceId),
    spanId: opt(row.spanId),
    parentSpanId: opt(row.parentSpanId),
    durationMs: opt(row.durationMs),
    attributes: row.attributes,
    createdAt: row.createdAt,
  };
}

/** The levels at or above `min`. */
function levelsFrom(min: ActivityLevel): ActivityLevel[] {
  return ACTIVITY_LEVELS.slice(ACTIVITY_LEVELS.indexOf(min));
}

/** Case-insensitive substring match on name, message or stored attributes; LIKE wildcards in the term are literal. */
function textMatch(term: string): SQL {
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return sql`(${activityEvents.name} ilike ${pattern} or ${activityEvents.message} ilike ${pattern} or ${activityEvents.attributes}::text ilike ${pattern})`;
}

export function createActivityRepository(db: StudixDb, clock: Clock): ActivityRepository {
  return {
    async append(ctx, input) {
      const rows = await db
        .insert(activityEvents)
        .values({
          id: input.id ?? newId("act"),
          ...tenantValues(ctx),
          name: input.name,
          level: input.level,
          message: input.message ?? null,
          projectId: input.projectId ?? null,
          jobId: input.jobId ?? null,
          stage: input.stage ?? null,
          provider: input.provider ?? null,
          model: input.model ?? null,
          traceId: input.traceId ?? null,
          spanId: input.spanId ?? null,
          parentSpanId: input.parentSpanId ?? null,
          durationMs: input.durationMs ?? null,
          attributes: redactDeep(input.attributes),
          createdAt: clock.now(),
        })
        .returning();
      return toActivity(first(rows, "activity event"));
    },
    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const ascending = query.order === "asc";
      const rows = await db
        .select()
        .from(activityEvents)
        .where(
          scoped(
            activityEvents,
            ctx,
            query.cursor === undefined
              ? undefined
              : ascending
                ? gt(activityEvents.id, query.cursor)
                : lt(activityEvents.id, query.cursor),
            query.projectId ? eq(activityEvents.projectId, query.projectId) : undefined,
            query.jobId ? eq(activityEvents.jobId, query.jobId) : undefined,
            query.traceId ? eq(activityEvents.traceId, query.traceId) : undefined,
            query.since ? gte(activityEvents.createdAt, query.since) : undefined,
            query.until ? lte(activityEvents.createdAt, query.until) : undefined,
            query.minLevel ? inArray(activityEvents.level, levelsFrom(query.minLevel)) : undefined,
            query.search ? textMatch(query.search) : undefined,
          ),
        )
        .orderBy(ascending ? asc(activityEvents.id) : desc(activityEvents.id))
        .limit(limit + 1);
      return toPage(rows.map(toActivity), limit);
    },
    async listAfter(ctx, query) {
      const rows = await db
        .select()
        .from(activityEvents)
        .where(
          scoped(
            activityEvents,
            ctx,
            eq(activityEvents.jobId, query.jobId),
            eq(activityEvents.name, query.name),
            query.afterId ? gt(activityEvents.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(activityEvents.id))
        .limit(Math.min(Math.max(query.limit ?? 500, 1), 1000));
      return rows.map(toActivity);
    },
  };
}
