import type { StudixErrorPayload } from "@studix/shared";
import type { RenderPreset, RenderSpec } from "@studix/video-ir";
import type { MediaJobRecord } from "../ports/media-provider.ts";
import type { ActorRef, TenantOwned } from "./common.ts";

export const JOB_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  /** Parked until the MCP host agent submits the output of a handed-off stage. */
  "waiting_host",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(["succeeded", "failed", "cancelled"]);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

/** Well-known job kinds; workflows may register more (kinds are open strings). */
export const JOB_KINDS = {
  createVideo: "video.create",
  render: "video.render",
  publish: "video.publish",
  /** ffmpeg or ffprobe with raw arguments in the sandbox (studix_media_exec). */
  mediaExec: "media.exec",
  /** A shell command in the skill sandbox over a composition workspace (studix_composition_run). */
  compositionRun: "composition.run",
} as const;

/**
 * Durable unit of work in the Postgres-backed queue. Lease fields (`lockedBy`, `leaseExpiresAt`) are owned
 * by the worker; `cancelRequested` is how a running job is asked to stop.
 */
export interface Job extends TenantOwned {
  projectId?: string;
  workflowRunId?: string;
  kind: string;
  status: JobStatus;
  /** Current stage name (e.g. "plan", "render-preview"). */
  stage?: string;
  /** 0..1 */
  progress: number;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: StudixErrorPayload;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedBy?: string;
  leaseExpiresAt?: Date;
  idempotencyKey?: string;
  cancelRequested: boolean;
  deadlineAt?: Date;
  /**
   * Deadline budget left while the job waits at a human gate or for a host agent task. The deadline is
   * paused then (`deadlineAt` is unset) and re-armed from this value when a worker claims the job again.
   */
  deadlineRemainingMs?: number;
  /**
   * The execution window the caller asked for when the job was created. A retry re-arms the deadline with
   * this window, so it never exceeds what was requested (a job born at a gate starts its clock at the first claim).
   */
  deadlineWindowMs?: number;
  budgetCents?: number;
  spentCents: number;
  createdBy: ActorRef;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export const STAGE_STATUSES = ["pending", "running", "succeeded", "failed", "skipped", "cancelled"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** One attempt of one named stage of a job (checkpoint for resume). */
export interface Stage extends TenantOwned {
  jobId: string;
  name: string;
  attempt: number;
  status: StageStatus;
  output?: Record<string, unknown>;
  error?: StudixErrorPayload;
  /**
   * Upstream media jobs this attempt submitted (the stage's media job journal), written with the stage row
   * as soon as a job is submitted. A later attempt of the stage reads them back and collects a paid job by
   * id instead of submitting it again. Omitted on a write, the stored records are kept.
   */
  mediaJobs?: MediaJobRecord[];
  startedAt?: Date;
  finishedAt?: Date;
  /**
   * Last real work of a running stage (an agent event), written by the run's heartbeat. Omitted on a write,
   * the stored time is kept. Stages that never report activity leave it unset and are never shown stalled.
   */
  lastActivityAt?: Date;
}

export const WORKFLOW_RUN_STATUSES = [
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** An execution of a workflow template, grouping its jobs. */
export interface WorkflowRun extends TenantOwned {
  projectId?: string;
  template: string;
  status: WorkflowRunStatus;
  input: Record<string, unknown>;
  createdBy: ActorRef;
  updatedAt: Date;
  finishedAt?: Date;
}

export const RENDER_STATUSES = ["queued", "rendering", "succeeded", "failed", "cancelled"] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];

/** Probe of a rendered media file. */
export interface MediaProbe {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec?: string;
  bytes: number;
}

export interface Render extends TenantOwned {
  projectId: string;
  versionId: string;
  jobId?: string;
  preset: RenderPreset;
  spec: RenderSpec;
  status: RenderStatus;
  /** Output asset version once stored. */
  assetVersionId?: string;
  storageKey?: string;
  probe?: MediaProbe;
  error?: StudixErrorPayload;
  updatedAt: Date;
  completedAt?: Date;
}
