import type {
  Approval,
  ApprovalRepository,
  AuditEvent,
  AuditRepository,
  Review,
  ReviewRepository,
} from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { and, desc, eq } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
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
    estimatedCostCents: opt(row.estimatedCostCents),
    requestedBy: actorFrom(row.requestedByType, row.requestedById),
    decidedBy:
      row.decidedByType && row.decidedById ? actorFrom(row.decidedByType, row.decidedById) : undefined,
    decidedAt: opt(row.decidedAt),
    comment: opt(row.comment),
    expiresAt: opt(row.expiresAt),
    createdAt: row.createdAt,
  };
}

export function createApprovalRepository(db: StudixDb, clock: Clock): ApprovalRepository {
  const repo: ApprovalRepository = {
    async create(ctx, input) {
      const rows = await db
        .insert(approvals)
        .values({
          id: input.id ?? newId("apr"),
          ...tenantValues(ctx),
          action: input.action,
          subjectType: input.subject.type,
          subjectId: input.subject.id,
          status: "pending",
          reason: input.reason,
          estimatedCostCents: input.estimatedCostCents ?? null,
          requestedByType: input.requestedBy.type,
          requestedById: input.requestedBy.id,
          expiresAt: input.expiresAt ?? null,
          createdAt: clock.now(),
        })
        .returning();
      return toApproval(first(rows, "approval"));
    },
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(approvals)
        .where(scoped(approvals, ctx, eq(approvals.id, id)));
      return rows[0] ? toApproval(rows[0]) : undefined;
    },
    async findLatest(ctx, subject, action) {
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
        })
        .where(scoped(approvals, ctx, eq(approvals.id, id), eq(approvals.status, "pending")))
        .returning();
      if (rows[0]) return toApproval(rows[0]);
      const current = await repo.get(ctx, id);
      if (!current) throw new StudixError("NOT_FOUND", `approval ${id} not found`);
      throw new StudixError("CONFLICT", `approval ${id} is already ${current.status}`);
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
    status: row.status,
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
          status: "open",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toReview(first(rows, "review"));
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

export function createAuditRepository(db: StudixDb, clock: Clock): AuditRepository {
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
