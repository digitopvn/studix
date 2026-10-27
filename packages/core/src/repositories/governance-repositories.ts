import type { NewRecord } from "../entities/common.ts";
import type {
  Approval,
  ApprovalAction,
  ApprovalStatus,
  ApprovalSubject,
  Review,
  ReviewStatus,
} from "../entities/review.ts";
import type { AuditEvent } from "../entities/telemetry.ts";
import type { ActorRef, TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export type NewApproval = Omit<NewRecord<Approval>, "status" | "decidedBy" | "decidedAt" | "comment">;

export interface ApprovalDecision {
  status: Exclude<ApprovalStatus, "pending">;
  decidedBy?: ActorRef;
  decidedAt: Date;
  comment?: string;
}

export interface ApprovalRepository {
  create(ctx: TenantContext, input: NewApproval): Promise<Approval>;
  /**
   * The one way to request approval: returns the live pending approval for the same subject, action and
   * scope key, or creates it. Pending requests whose expiry has passed are closed as `expired` first, so
   * concurrent callers always converge on a single pending row. `created` is false when one already existed.
   */
  open(ctx: TenantContext, input: NewApproval): Promise<{ approval: Approval; created: boolean }>;
  get(ctx: TenantContext, id: string): Promise<Approval | undefined>;
  /** Most recent approval for this subject and action, any status. */
  findLatest(
    ctx: TenantContext,
    subject: ApprovalSubject,
    action: ApprovalAction,
  ): Promise<Approval | undefined>;
  list(
    ctx: TenantContext,
    query?: PageRequest & { status?: ApprovalStatus; subject?: ApprovalSubject },
  ): Promise<Page<Approval>>;
  /** Transition a pending approval; throws CONFLICT if it is no longer pending. */
  decide(ctx: TenantContext, id: string, decision: ApprovalDecision): Promise<Approval>;
  /**
   * Atomically spend an approved single-use approval (approved -> consumed). Returns false when it was
   * not in `approved` state, so of two concurrent callers exactly one gets true.
   */
  consume(ctx: TenantContext, id: string): Promise<boolean>;
}

export type NewReview = Omit<NewRecord<Review>, "status">;

export interface ReviewRepository {
  create(ctx: TenantContext, input: NewReview): Promise<Review>;
  list(
    ctx: TenantContext,
    query: PageRequest & { projectId: string; versionId?: string },
  ): Promise<Page<Review>>;
  setStatus(ctx: TenantContext, id: string, status: ReviewStatus): Promise<Review>;
}

export type NewAuditEvent = NewRecord<AuditEvent>;

/** Append-only. */
export interface AuditRepository {
  append(ctx: TenantContext, input: NewAuditEvent): Promise<AuditEvent>;
  list(
    ctx: TenantContext,
    query?: PageRequest & { subjectType?: string; subjectId?: string },
  ): Promise<Page<AuditEvent>>;
}
