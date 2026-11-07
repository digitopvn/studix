import type { ActorRef, TenantOwned } from "./common.ts";

/** A point or size on the video frame, as a fraction of its width or height (0 to 1). */
export interface FramePoint {
  x: number;
  y: number;
}

/**
 * What a reviewer marked on a paused frame, so an agent knows exactly where and what to change:
 * a region, pins, pen or arrow strokes, a snapshot of the frame with the marks, and references.
 */
export interface ReviewAnnotation {
  intent?: "change" | "fix" | "remove" | "add" | "keep";
  priority?: "must" | "should" | "nice";
  /** The paused frame the marks were drawn on. */
  frameMs?: number;
  region?: FramePoint & { w: number; h: number };
  pins?: Array<FramePoint & { label?: string }>;
  strokes?: Array<{ tool: "pen" | "arrow"; points: FramePoint[] }>;
  /** The frame with the marks drawn on it, as an image data URL. */
  snapshot?: string;
  references?: Array<{ url: string; note?: string }>;
}

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
  annotation?: ReviewAnnotation;
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

/**
 * `consumed`: a single-use approval (a mutating connector call) that has already been spent.
 * `changes_requested`: a creative gate sent back with named assets to redo; the job redoes them and asks again.
 */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
  "consumed",
  "changes_requested",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalSubject {
  type: ApprovalSubjectType;
  id: string;
}

/** What a reviewer asked to redo at a creative gate. */
export interface ApprovalChanges {
  /** Asset ids of the reviewed version to regenerate; nothing else is redone. */
  targets: string[];
  /** The reviewer's instruction, added to each target's generation prompt. */
  note: string;
  /** Node keys of the reviewed version that depend on the targets (the targets included), sorted. */
  invalidated: string[];
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
  /** Set when the decision is `changes_requested`. */
  changes?: ApprovalChanges;
  expiresAt?: Date;
}
