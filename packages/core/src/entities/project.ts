import type { CreativeBrief, VideoIR, VideoIRPatch } from "@studix/video-ir";
import type { ActorRef, TenantOwned } from "./common.ts";

export const PROJECT_STATUSES = [
  "draft",
  "planning",
  "rendering",
  "in_review",
  "approved",
  "published",
  "failed",
  "archived",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface VideoProject extends TenantOwned {
  title: string;
  status: ProjectStatus;
  brief: CreativeBrief;
  /** Workflow pack id from the pack registry (e.g. `brand-intro`); undefined for legacy projects. */
  workflowTemplate?: string;
  /** Latest accepted IR version; undefined until planning produced one. */
  currentVersionId?: string;
  createdBy: ActorRef;
  updatedAt: Date;
}

export type ProjectVersionSource = "client" | "planner" | "patch" | "migration";

/** Immutable IR revision. `version` increases by one per project. */
export interface ProjectVersion extends TenantOwned {
  projectId: string;
  version: number;
  ir: VideoIR;
  source: ProjectVersionSource;
  parentVersionId?: string;
  /** Patch that produced this version from its parent, when source is "patch". */
  patch?: VideoIRPatch;
  /** Client idempotency key of the request that created the version; unique per project. */
  idempotencyKey?: string;
  /** Feedback comment the version was created for, so a request that stopped midway can be completed. */
  feedbackId?: string;
  createdBy: ActorRef;
}
