import type { ActorRef, TenantOwned } from "./common.ts";

export const REVIEW_STATUSES = ["open", "resolved"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Human feedback on a project version, optionally anchored to a node of the IR or a time range.
 * `targetId` is a node key: `storyboard`, `scene:<id>`, `shot:<id>` or `asset:<id>`.
 */
export interface Review extends TenantOwned {
  projectId: string;
  versionId?: string;
  author: ActorRef;
  body: string;
  /** Node key (`storyboard`, `scene:<id>`, `shot:<id>`, `asset:<id>`) the comment refers to. */
  targetId?: string;
  /** Start of the commented time range on the video timeline. */
  atMs?: number;
  /** End (exclusive) of the commented time range; only with `atMs`. */
  endMs?: number;
  status: ReviewStatus;
  /** Client retry key of a comment sent without a patch (a patch stores its key on the version). */
  idempotencyKey?: string;
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
  /** An agent stage stopped at a cap; approving grants one more run with every cap doubled. */
  "agent.overrun",
  /**
   * A creative milestone a person signs off before the workflow spends on what follows (a pack's G0 brief,
   * G1 designs). Scoped `gate:<id>` per milestone of the job.
   */
  "creative.gate",
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
  /**
   * Distinguishes independent requests for the same subject and action (e.g. one connector tool + argument
   * set per approval). Only one pending approval may exist per subject, action and scope key.
   */
  scopeKey?: string;
  estimatedCostCents?: number;
  requestedBy: ActorRef;
  decidedBy?: ActorRef;
  decidedAt?: Date;
  comment?: string;
  expiresAt?: Date;
}
