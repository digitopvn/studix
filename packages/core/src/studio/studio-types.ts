import type { Clock, Logger, StudixErrorPayload } from "@studix/shared";
import { CreativeBrief, RenderPreset } from "@studix/video-ir";
import { z } from "zod";
import type { Job, JobStatus, StageStatus } from "../entities/job.ts";
import type { Approval, ApprovalAction, ApprovalStatus, ApprovalSubjectType } from "../entities/review.ts";
import type { ApprovalPolicy } from "../ports/approval-policy.ts";
import type { JobQueue } from "../ports/job-queue.ts";
import type { AssetRepository } from "../repositories/asset-repository.ts";
import type { ApprovalRepository, AuditRepository } from "../repositories/governance-repositories.ts";
import type { JobRepository, RenderRepository } from "../repositories/job-repository.ts";
import type { ProjectRepository } from "../repositories/project-repository.ts";

/** MCP tool names that next-action hints point to (the MCP server registers tools with these names). */
export const STUDIX_TOOLS = {
  inspect: "studix_inspect",
  createVideo: "studix_create_video",
  getJob: "studix_get_job",
  getProject: "studix_get_project",
  approve: "studix_approve",
  listAssets: "studix_list_assets",
} as const;

/** A suggested follow-up call, so clients never have to guess the workflow. */
export interface NextAction {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
  /** For polling hints: wait at least this long before calling. */
  pollAfterMs?: number;
}

export interface StudioDefaults {
  jobBudgetCents: number;
  jobDeadlineMs: number;
  jobMaxAttempts: number;
  /** How long a pending approval stays valid. */
  approvalTtlMs: number;
}

export interface StudioServiceDeps {
  projects: ProjectRepository;
  jobs: JobRepository;
  renders: RenderRepository;
  assets: AssetRepository;
  approvals: ApprovalRepository;
  audit: AuditRepository;
  queue: JobQueue;
  approvalPolicy: ApprovalPolicy;
  clock: Clock;
  logger?: Logger;
  defaults?: Partial<StudioDefaults>;
}

const IdempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,200}$/, "1-200 chars of letters, digits, '.', '_', ':' or '-'");

/** Boundary schema for createVideoProject; `spec` is checked separately with validateVideoIR. */
export const CreateVideoProjectInput = z.object({
  brief: CreativeBrief,
  spec: z.unknown().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: IdempotencyKey.optional(),
  budgetCents: z.number().int().min(0).max(10_000_000).optional(),
  deadlineAt: z.coerce.date().optional(),
  renderPreset: RenderPreset.optional(),
});
export type CreateVideoProjectInput = z.input<typeof CreateVideoProjectInput>;

export const RequestApprovalInput = z.object({
  action: z.enum(["job.start", "render.final", "publish", "provider.spend", "connector.execute", "delete"]),
  subjectType: z.enum(["project", "project_version", "job", "render", "asset"]),
  subjectId: z.string().min(1).max(100),
  reason: z.string().trim().min(1).max(1000).optional(),
  estimatedCostCents: z.number().int().min(0).optional(),
});
export type RequestApprovalInput = z.input<typeof RequestApprovalInput>;

export const DecideApprovalInput = z.object({
  approvalId: z.string().min(1).max(100),
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().trim().max(2000).optional(),
});
export type DecideApprovalInput = z.input<typeof DecideApprovalInput>;

export const RecordAuditInput = z.object({
  action: z.string().regex(/^[a-z][a-z0-9_.-]{1,99}$/, "dotted lowercase action name"),
  subjectType: z.string().min(1).max(60),
  subjectId: z.string().min(1).max(100).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type RecordAuditInput = z.input<typeof RecordAuditInput>;

export interface StageView {
  name: string;
  status: StageStatus;
  attempt: number;
  startedAt?: Date;
  finishedAt?: Date;
  error?: StudixErrorPayload;
}

export interface ApprovalView {
  id: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  reason: string;
  subjectType: ApprovalSubjectType;
  subjectId: string;
  expiresAt?: Date;
}

/** Client-facing job state: progress, structured error and what to do next. */
export interface JobView {
  id: string;
  kind: string;
  status: JobStatus;
  projectId?: string;
  stage?: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  budget: { limitCents?: number; spentCents: number };
  deadlineAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  result?: Record<string, unknown>;
  error?: StudixErrorPayload;
  stages: StageView[];
  approval?: ApprovalView;
  next: NextAction[];
}

export type { Approval, Job };
