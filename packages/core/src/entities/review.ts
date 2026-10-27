import type { ActorRef, TenantOwned } from "./common.ts";

export const REVIEW_STATUSES = ["open", "resolved"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Human feedback on a project version (optionally anchored to a scene/shot or timestamp). */
export interface Review extends TenantOwned {
  projectId: string;
  versionId?: string;
  author: ActorRef;
  body: string;
  /** IR element id (scene or shot) the comment refers to. */
  targetId?: string;
  atMs?: number;
  status: ReviewStatus;
  updatedAt: Date;
}

/** Side-effecting actions that an ApprovalPolicy may gate. */
export const APPROVAL_ACTIONS = [
  "job.start",
  "render.final",
  "publish",
  "provider.spend",
  "connector.execute",
  "delete",
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const APPROVAL_SUBJECT_TYPES = ["project", "project_version", "job", "render", "asset"] as const;
export type ApprovalSubjectType = (typeof APPROVAL_SUBJECT_TYPES)[number];

/** `consumed`: a single-use approval (a mutating connector call) that has already been spent. */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
  "consumed",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalSubject {
  type: ApprovalSubjectType;
  id: string;
}

export interface Approval extends TenantOwned {
  action: ApprovalAction;
  subject: ApprovalSubject;
  status: ApprovalStatus;
  reason: string;
  estimatedCostCents?: number;
  requestedBy: ActorRef;
  decidedBy?: ActorRef;
  decidedAt?: Date;
  comment?: string;
  expiresAt?: Date;
  /** Distinguishes concurrent requests for the same subject and action; at most one pending per key. */
  requestKey?: string;
}
