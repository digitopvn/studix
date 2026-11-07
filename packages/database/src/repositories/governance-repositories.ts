import {
  type Approval,
  type ApprovalRepository,
  type AuditEvent,
  type AuditRepository,
  actorRef,
  type NewApproval,
  type Review,
  type ReviewRepository,
  type TenantContext,
} from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { DbExecutor, StudixDb } from "../client.ts";
import { approvals } from "../schema/jobs.ts";
import { reviews } from "../schema/projects.ts";
import { auditEvents } from "../schema/telemetry.ts";
import { actorFrom, beforeCursor, first, opt, pageLimit, scoped, tenantValues, toPage } from "./helpers.ts";

function toApproval(row: typeof approvals.$inferSelect): Approval {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    action: row.action,
    subject: { type: row.subjectType, id: row.subjectId },
    status: row.status,
    reason: row.reason,
    scopeKey: row.scopeKey === "" ? undefined : row.scopeKey,
    estimatedCostCents: opt(row.estimatedCostCents),
    requestedBy: actorFrom(row.requestedByType, row.requestedById),
    decidedBy:
      row.decidedByType && row.decidedById ? actorFrom(row.decidedByType, row.decidedById) : undefined,
    decidedAt: opt(row.decidedAt),
    comment: opt(row.comment),
    changes: opt(row.changes),
    expiresAt: opt(row.expiresAt),
    createdAt: row.createdAt,
  };
}

export function createApprovalRepository(db: DbExecutor, clock: Clock): ApprovalRepository {
  const values = (ctx: TenantContext, input: NewApproval) => ({
    id: input.id ?? newId("apr"),
    ...tenantValues(ctx),
    action: input.action,
    subjectType: input.subject.type,
    subjectId: input.subject.id,
    status: "pending" as const,
    reason: input.reason,
    scopeKey: input.scopeKey ?? "",
    estimatedCostCents: input.estimatedCostCents ?? null,
    requestedByType: input.requestedBy.type,
    requestedById: input.requestedBy.id,
    expiresAt: input.expiresAt ?? null,
    createdAt: clock.now(),
  });
  const repo: ApprovalRepository = {
    async create(ctx, input) {
      const rows = await db.insert(approvals).values(values(ctx, input)).returning();
      return toApproval(first(rows, "approval"));
    },
    async open(ctx, input) {
      const sameRequest = and(
        eq(approvals.subjectType, input.subject.type),
        eq(approvals.subjectId, input.subject.id),
        eq(approvals.action, input.action),
        eq(approvals.scopeKey, input.scopeKey ?? ""),
        eq(approvals.status, "pending"),
      );
      // An expired request still occupies the unique slot until it is closed.
      const now = clock.now();
      const expired = await db
        .update(approvals)
        .set({ status: "expired", decidedAt: now })
        .where(
          scoped(approvals, ctx, sameRequest, isNotNull(approvals.expiresAt), lte(approvals.expiresAt, now)),
        )
        .returning({ id: approvals.id });
      const sweeper = { type: "system" as const, id: "approval-sweeper" };
      for (const row of expired) {
        await createAuditRepository(db, clock).append(
          { ...ctx, actor: sweeper },
          {
            actor: actorRef(sweeper),
            action: "approval.expired",
            subjectType: input.subject.type,
            subjectId: input.subject.id,
            data: { approvalId: row.id, action: input.action },
          },
        );
      }
      // The request found pending can be decided between the insert conflict and the read; retry then.
      for (let attempt = 0; attempt < 3; attempt++) {
        const inserted = await db
          .insert(approvals)
          .values(values(ctx, input))
          .onConflictDoNothing({
            target: [
              approvals.workspaceId,
              approvals.subjectType,
              approvals.subjectId,
              approvals.action,
              approvals.scopeKey,
            ],
            where: sql`${approvals.status} = 'pending'`,
          })
          .returning();
        if (inserted[0]) return { approval: toApproval(inserted[0]), created: true };
        const existing = await db
          .select()
          .from(approvals)
          .where(scoped(approvals, ctx, sameRequest))
          .limit(1);
        if (existing[0]) return { approval: toApproval(existing[0]), created: false };
      }
      throw new StudixError("CONFLICT", "approval request is changing concurrently; retry", {
        retryable: true,
      });
    },
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(approvals)
        .where(scoped(approvals, ctx, eq(approvals.id, id)));
      return rows[0] ? toApproval(rows[0]) : undefined;
    },
    async findLatest(ctx, subject, action, scopeKey) {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          scoped(
            approvals,
            ctx,
            eq(approvals.subjectType, subject.type),
            eq(approvals.subjectId, subject.id),
            eq(approvals.action, action),
            scopeKey === undefined ? undefined : eq(approvals.scopeKey, scopeKey),
          ),
        )
        .orderBy(desc(approvals.id))
        .limit(1);
      return rows[0] ? toApproval(rows[0]) : undefined;
    },
    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(approvals)
        .where(
          scoped(
            approvals,
            ctx,
            beforeCursor(approvals.id, query.cursor),
            query.status ? eq(approvals.status, query.status) : undefined,
            query.subject
              ? and(eq(approvals.subjectType, query.subject.type), eq(approvals.subjectId, query.subject.id))
              : undefined,
          ),
        )
        .orderBy(desc(approvals.id))
        .limit(limit + 1);
      return toPage(rows.map(toApproval), limit);
    },
    async decide(ctx, id, decision) {
      const rows = await db
        .update(approvals)
        .set({
          status: decision.status,
          decidedByType: decision.decidedBy?.type ?? null,
          decidedById: decision.decidedBy?.id ?? null,
          decidedAt: decision.decidedAt,
          comment: decision.comment ?? null,
          changes: decision.changes ?? null,
        })
        .where(scoped(approvals, ctx, eq(approvals.id, id), eq(approvals.status, "pending")))
        .returning();
      if (rows[0]) return toApproval(rows[0]);
      const current = await repo.get(ctx, id);
      if (!current) throw new StudixError("NOT_FOUND", `approval ${id} not found`);
      throw new StudixError("CONFLICT", `approval ${id} is already ${current.status}`);
    },
    async consume(ctx, id) {
      const rows = await db
        .update(approvals)
        .set({ status: "consumed" })
        .where(scoped(approvals, ctx, eq(approvals.id, id), eq(approvals.status, "approved")))
        .returning({ id: approvals.id });
      return rows.length === 1;
    },
  };
  return repo;
}

function toReview(row: typeof reviews.$inferSelect): Review {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    versionId: opt(row.versionId),
    author: actorFrom(row.authorType, row.authorId),
    body: row.body,
    targetId: opt(row.targetId),
    atMs: opt(row.atMs),
    endMs: opt(row.endMs),
    annotation: opt(row.annotation),
    status: row.status,
    idempotencyKey: opt(row.idempotencyKey),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createReviewRepository(db: StudixDb, clock: Clock): ReviewRepository {
  return {
    async create(ctx, input) {
      const now = clock.now();
      const rows = await db
        .insert(reviews)
        .values({
          id: input.id ?? newId("rev"),
          ...tenantValues(ctx),
          projectId: input.projectId,
          versionId: input.versionId ?? null,
          authorType: input.author.type,
          authorId: input.author.id,
          body: input.body,
          targetId: input.targetId ?? null,
          atMs: input.atMs ?? null,
          endMs: input.endMs ?? null,
          annotation: input.annotation ?? null,
          status: "open",
          idempotencyKey: input.idempotencyKey ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toReview(first(rows, "review"));
    },
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(reviews)
        .where(scoped(reviews, ctx, eq(reviews.id, id)));
      return rows[0] ? toReview(rows[0]) : undefined;
    },
    async findByIdempotencyKey(ctx, projectId, idempotencyKey) {
      const rows = await db
        .select()
        .from(reviews)
        .where(
          scoped(reviews, ctx, eq(reviews.projectId, projectId), eq(reviews.idempotencyKey, idempotencyKey)),
        );
      return rows[0] ? toReview(rows[0]) : undefined;
    },
    async list(ctx, query) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(reviews)
        .where(
          scoped(
            reviews,
            ctx,
            eq(reviews.projectId, query.projectId),
            query.versionId ? eq(reviews.versionId, query.versionId) : undefined,
            beforeCursor(reviews.id, query.cursor),
          ),
        )
        .orderBy(desc(reviews.id))
        .limit(limit + 1);
      return toPage(rows.map(toReview), limit);
    },
    async setStatus(ctx, id, status) {
      const rows = await db
        .update(reviews)
        .set({ status, updatedAt: clock.now() })
        .where(scoped(reviews, ctx, eq(reviews.id, id)))
        .returning();
      return toReview(first(rows, `review ${id}`));
    },
  };
}

function toAudit(row: typeof auditEvents.$inferSelect): AuditEvent {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    actor: actorFrom(row.actorType, row.actorId),
    action: row.action,
    subjectType: row.subjectType,
    subjectId: opt(row.subjectId),
    data: opt(row.data),
    createdAt: row.createdAt,
  };
}

export function createAuditRepository(db: DbExecutor, clock: Clock): AuditRepository {
  return {
    async append(ctx, input) {
      const rows = await db
        .insert(auditEvents)
        .values({
          id: input.id ?? newId("aud"),
          ...tenantValues(ctx),
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: input.action,
          subjectType: input.subjectType,
          subjectId: input.subjectId ?? null,
          data: input.data ?? null,
          createdAt: clock.now(),
        })
        .returning();
      return toAudit(first(rows, "audit event"));
    },
    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(auditEvents)
        .where(
          scoped(
            auditEvents,
            ctx,
            beforeCursor(auditEvents.id, query.cursor),
            query.subjectType ? eq(auditEvents.subjectType, query.subjectType) : undefined,
            query.subjectId ? eq(auditEvents.subjectId, query.subjectId) : undefined,
          ),
        )
        .orderBy(desc(auditEvents.id))
        .limit(limit + 1);
      return toPage(rows.map(toAudit), limit);
    },
  };
}
