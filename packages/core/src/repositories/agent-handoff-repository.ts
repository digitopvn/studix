import type { AgentHandoff, AgentHandoffUsage } from "../entities/agent-handoff.ts";
import type { NewRecord } from "../entities/common.ts";
import type { ActorRef, TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export type NewAgentHandoff = Omit<
  NewRecord<AgentHandoff>,
  "status" | "output" | "outputDigest" | "usage" | "submittedBy" | "submittedAt"
>;

/** A host agent's output for one task, already validated against the stage's output schema. */
export interface AgentHandoffSubmission {
  id: string;
  /** The attempt the host was given with the task. */
  attempt: number;
  output: Record<string, unknown>;
  outputDigest: string;
  usage?: AgentHandoffUsage;
  submittedBy: ActorRef;
}

/**
 * Why a submission was refused. `stale_attempt`: the task belongs to another attempt. `already_submitted`:
 * a different output was accepted before. `not_waiting`: the task or its job no longer waits for the host
 * (cancelled, failed, resumed). `expired`: the time limit passed.
 */
export const AGENT_HANDOFF_REJECTIONS = [
  "not_found",
  "stale_attempt",
  "already_submitted",
  "not_waiting",
  "expired",
] as const;
export type AgentHandoffRejection = (typeof AGENT_HANDOFF_REJECTIONS)[number];

export type AgentHandoffSubmitResult =
  | { status: "accepted" | "duplicate"; handoff: AgentHandoff }
  | { status: "rejected"; reason: AgentHandoffRejection; handoff?: AgentHandoff };

export interface AgentHandoffRepository {
  /**
   * Return the pending task of this job stage, or create it. Called by the worker inside the fenced
   * transaction that parks the job, so a worker that lost the job opens nothing.
   */
  open(ctx: TenantContext, input: NewAgentHandoff): Promise<{ handoff: AgentHandoff; created: boolean }>;
  get(ctx: TenantContext, id: string): Promise<AgentHandoff | undefined>;
  /** Most recent task of a job stage, any status. */
  findLatest(ctx: TenantContext, jobId: string, stage: string): Promise<AgentHandoff | undefined>;
  /** Pending tasks whose job is still parked in `waiting_host`, newest first. */
  listPending(ctx: TenantContext, query?: PageRequest & { jobId?: string }): Promise<Page<AgentHandoff>>;
  /**
   * Accept a submission atomically with the job transition: the task goes pending -> submitted and its job
   * waiting_host -> queued, only while the task is pending, unexpired, for `attempt`, and its job is still
   * parked at that attempt. Repeating the accepted submission (same digest and attempt) is `duplicate`.
   */
  submit(ctx: TenantContext, submission: AgentHandoffSubmission): Promise<AgentHandoffSubmitResult>;
}
