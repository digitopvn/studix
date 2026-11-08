import { type Clock, StudixError } from "@studix/shared";
import type { Approval, Review } from "../entities/review.ts";
import {
  ACTIVITY_LEVELS,
  type ActivityEvent,
  type AuditEvent,
  type ProviderExecution,
  type UsageEvent,
} from "../entities/telemetry.ts";
import type {
  ApprovalRepository,
  AuditRepository,
  ReviewRepository,
} from "../repositories/governance-repositories.ts";
import { pageLimit, toPage } from "../repositories/pagination.ts";
import type {
  ActivityRepository,
  UsageRange,
  UsageRepository,
} from "../repositories/telemetry-repositories.ts";
import { InMemoryTenantTable } from "./in-memory-table.ts";

export function createInMemoryApprovalRepository(clock: Clock): ApprovalRepository {
  const approvals = new InMemoryTenantTable<Approval>("apr", clock, false);
  return {
    async create(ctx, input) {
      return approvals.insert(ctx, { ...input, status: "pending" });
    },
    async open(ctx, input) {
      const now = clock.now();
      const sameRequest = (a: Approval) =>
        a.status === "pending" &&
        a.subject.type === input.subject.type &&
        a.subject.id === input.subject.id &&
        a.action === input.action &&
        (a.scopeKey ?? "") === (input.scopeKey ?? "");
      for (const stale of approvals.filter(ctx, sameRequest)) {
        if (stale.expiresAt !== undefined && stale.expiresAt <= now) {
          approvals.update(ctx, stale.id, { status: "expired", decidedAt: now });
        }
      }
      const existing = approvals.filter(ctx, sameRequest)[0];
      if (existing) return { approval: existing, created: false };
      return { approval: approvals.insert(ctx, { ...input, status: "pending" }), created: true };
    },
    async get(ctx, id) {
      return approvals.get(ctx, id);
    },
    async findLatest(ctx, subject, action, scopeKey) {
      return approvals.filter(
        ctx,
        (a) =>
          a.subject.type === subject.type &&
          a.subject.id === subject.id &&
          a.action === action &&
          (scopeKey === undefined || (a.scopeKey ?? "") === scopeKey),
      )[0];
    },
    async list(ctx, query = {}) {
      return approvals.page(
        ctx,
        query,
        (a) =>
          (query.status === undefined || a.status === query.status) &&
          (query.subject === undefined ||
            (a.subject.type === query.subject.type && a.subject.id === query.subject.id)),
      );
    },
    async decide(ctx, id, decision) {
      const current = approvals.require(ctx, id);
      if (current.status !== "pending") {
        throw new StudixError("CONFLICT", `approval ${id} is already ${current.status}`);
      }
      return approvals.update(ctx, id, decision);
    },
    async consume(ctx, id) {
      const current = approvals.get(ctx, id);
      if (current?.status !== "approved") return false;
      approvals.update(ctx, id, { status: "consumed" });
      return true;
    },
  };
}

export function createInMemoryReviewRepository(clock: Clock): ReviewRepository {
  const reviews = new InMemoryTenantTable<Review>("rev", clock);
  return {
    async create(ctx, input) {
      if (
        input.idempotencyKey !== undefined &&
        reviews.filter(
          ctx,
          (r) => r.projectId === input.projectId && r.idempotencyKey === input.idempotencyKey,
        ).length > 0
      ) {
        throw new StudixError("CONFLICT", `idempotency key ${input.idempotencyKey} is already used`);
      }
      return reviews.insert(ctx, { ...input, status: "open" });
    },
    async get(ctx, id) {
      return reviews.get(ctx, id);
    },
    async findByIdempotencyKey(ctx, projectId, idempotencyKey) {
      return reviews.filter(ctx, (r) => r.projectId === projectId && r.idempotencyKey === idempotencyKey)[0];
    },
    async list(ctx, query) {
      return reviews.page(
        ctx,
        query,
        (r) =>
          r.projectId === query.projectId &&
          (query.versionId === undefined || r.versionId === query.versionId),
      );
    },
    async setStatus(ctx, id, status) {
      return reviews.update(ctx, id, { status });
    },
  };
}

export function createInMemoryAuditRepository(clock: Clock): AuditRepository {
  const events = new InMemoryTenantTable<AuditEvent>("aud", clock, false);
  return {
    async append(ctx, input) {
      return events.insert(ctx, input);
    },
    async list(ctx, query = {}) {
      return events.page(
        ctx,
        query,
        (e) =>
          (query.subjectType === undefined || e.subjectType === query.subjectType) &&
          (query.subjectId === undefined || e.subjectId === query.subjectId),
      );
    },
  };
}

function inRange(row: { createdAt: Date; jobId?: string }, range: UsageRange): boolean {
  return (
    (range.jobId === undefined || row.jobId === range.jobId) &&
    (range.since === undefined || row.createdAt >= range.since) &&
    (range.until === undefined || row.createdAt < range.until)
  );
}

export function createInMemoryUsageRepository(clock: Clock): UsageRepository {
  const usage = new InMemoryTenantTable<UsageEvent>("use", clock, false);
  const executions = new InMemoryTenantTable<ProviderExecution>("pex", clock, false);
  return {
    async record(ctx, input) {
      const existing = usage.filter(ctx, (u) => u.dedupeKey === input.dedupeKey)[0];
      if (existing) {
        // An estimate is replaced by the receipt for the same job, never added to.
        if (existing.metadata?.costSource === "estimate" && input.metadata?.costSource === "receipt") {
          const { kind, quantity, unit, costCents, metadata } = input;
          return {
            event: usage.update(ctx, existing.id, { kind, quantity, unit, costCents, metadata }),
            created: false,
          };
        }
        return { event: existing, created: false };
      }
      return { event: usage.insert(ctx, { ...input, funding: input.funding ?? "operator" }), created: true };
    },
    async list(ctx, query = {}) {
      return usage.page(ctx, query, (u) => inRange(u, query));
    },
    async totalCostCents(ctx, range = {}) {
      return usage.filter(ctx, (u) => inRange(u, range)).reduce((sum, u) => sum + u.costCents, 0);
    },
    async recordProviderExecution(ctx, input) {
      return executions.insert(ctx, { ...input, funding: input.funding ?? "operator" });
    },
    async listProviderExecutions(ctx, query) {
      return executions.page(ctx, query, (e) => e.jobId === query.jobId);
    },
  };
}

export function createInMemoryActivityRepository(clock: Clock): ActivityRepository {
  const events = new InMemoryTenantTable<ActivityEvent>("act", clock, false);
  return {
    async append(ctx, input) {
      return events.insert(ctx, input);
    },
    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const ascending = query.order === "asc";
      const term = query.search?.toLowerCase();
      const levels = query.minLevel
        ? ACTIVITY_LEVELS.slice(ACTIVITY_LEVELS.indexOf(query.minLevel))
        : undefined;
      const rows = events
        .filter(
          ctx,
          (e) =>
            (query.projectId === undefined || e.projectId === query.projectId) &&
            (query.jobId === undefined || e.jobId === query.jobId) &&
            (query.traceId === undefined || e.traceId === query.traceId) &&
            (query.since === undefined || e.createdAt >= query.since) &&
            (query.until === undefined || e.createdAt <= query.until) &&
            (levels === undefined || levels.includes(e.level)) &&
            (term === undefined ||
              e.name.toLowerCase().includes(term) ||
              (e.message ?? "").toLowerCase().includes(term) ||
              JSON.stringify(e.attributes).toLowerCase().includes(term)) &&
            (query.cursor === undefined || (ascending ? e.id > query.cursor : e.id < query.cursor)),
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1) * (ascending ? 1 : -1));
      return toPage(rows.slice(0, limit + 1), limit);
    },
    async listAfter(ctx, query) {
      return events
        .filter(
          ctx,
          (e) =>
            e.jobId === query.jobId &&
            e.name === query.name &&
            (query.afterId === undefined || e.id > query.afterId),
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, query.limit ?? 500);
    },
  };
}
