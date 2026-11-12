import { redactDeep, StudixError } from "@studix/shared";
import { contentDigest } from "@studix/video-ir";
import { z } from "zod";
import type { AgentHandoff, AgentHandoffStatus, AgentStageLimits } from "../entities/agent-handoff.ts";
import { REASONING_EFFORTS } from "../entities/model-preference.ts";
import type {
  AgentHandoffRejection,
  AgentHandoffRepository,
} from "../repositories/agent-handoff-repository.ts";
import { actorRef, assertPermission, type TenantContext } from "../tenant.ts";

/** MCP tools of the host-agent handoff (the server registers them; core only names them for hints). */
export const AGENT_HANDOFF_TOOLS = {
  list: "studix_list_agent_tasks",
  get: "studix_get_agent_task",
  submit: "studix_submit_agent_task",
} as const;

export type AgentOutputCheck =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/**
 * Checks a host output against the schema the named stage hands a host agent (the same schema the worker applies
 * to the submission when the stage resumes).
 * Throws UNAVAILABLE when this server does not know the stage.
 */
export type AgentOutputValidator = (stage: string, output: unknown) => AgentOutputCheck;

export interface AgentHandoffServiceDeps {
  handoffs: AgentHandoffRepository;
  validateOutput: AgentOutputValidator;
}

export interface AgentTaskSummary {
  id: string;
  jobId: string;
  stage: string;
  attempt: number;
  status: AgentHandoffStatus;
  expiresAt: Date;
  createdAt: Date;
}

/** Everything a host agent needs to do the stage: the same contract the harness agent gets. */
export interface AgentTaskView extends AgentTaskSummary {
  instructions: string;
  input: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  limits: AgentStageLimits;
  submittedAt?: Date;
}

export interface AgentTaskSubmitInput {
  taskId: string;
  attempt: number;
  output: unknown;
  usage?: unknown;
}

export interface AgentTaskSubmitResult {
  task: AgentTaskSummary;
  /** True when this exact output had already been accepted for the attempt (nothing changed). */
  replayed: boolean;
}

const ReportedUsage = z
  .object({
    turns: z.number().int().min(0).max(10_000).optional(),
    inputTokens: z.number().int().min(0).max(1e9).optional(),
    outputTokens: z.number().int().min(0).max(1e9).optional(),
    model: z
      .string()
      .regex(/^[\w.:@/-]{1,100}$/)
      .optional(),
    /** Thinking level the host ran the model at; the MCP tool checks it against the model's catalog entry. */
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  })
  .strict();

function summary(h: AgentHandoff): AgentTaskSummary {
  return {
    id: h.id,
    jobId: h.jobId,
    stage: h.stage,
    attempt: h.attempt,
    status: h.status,
    expiresAt: h.expiresAt,
    createdAt: h.createdAt,
  };
}

function view(h: AgentHandoff): AgentTaskView {
  return {
    ...summary(h),
    instructions: h.instructions,
    input: h.input,
    outputSchema: h.outputSchema,
    limits: h.limits,
    ...(h.submittedAt ? { submittedAt: h.submittedAt } : {}),
  };
}

function rejection(reason: AgentHandoffRejection, handoff?: AgentHandoff): StudixError {
  const details = { reason, ...(handoff ? { taskId: handoff.id, attempt: handoff.attempt } : {}) };
  switch (reason) {
    case "not_found":
      return new StudixError("NOT_FOUND", "Agent task not found", { details });
    case "stale_attempt":
      return new StudixError("CONFLICT", "The output names another attempt than the task's", {
        retryable: false,
        details,
        suggestedAction: "Fetch the task again with studix_get_agent_task and submit with its attempt.",
      });
    case "already_submitted":
      return new StudixError("CONFLICT", "A different output was already accepted for this task", {
        retryable: false,
        details,
      });
    case "not_waiting":
      return new StudixError("CONFLICT", "The task's job no longer waits for this output", {
        retryable: false,
        details: { ...details, status: handoff?.status },
        suggestedAction: "Poll studix_get_job; the job was cancelled, failed or moved on.",
      });
    case "expired":
      return new StudixError("TIMEOUT", "The agent task expired before an output was submitted", {
        retryable: false,
        details,
        suggestedAction: "A workspace member decides in the dashboard whether the stage gets more time.",
      });
  }
}

/**
 * Host side of an agent stage handoff: lists and reads parked tasks, and accepts outputs. Every output is
 * checked against the stage's output schema before anything is stored, secrets are redacted from it, and
 * the store accepts it only for the attempt the task was opened in (see AgentHandoffRepository.submit).
 */
export function createAgentHandoffService(deps: AgentHandoffServiceDeps) {
  return {
    async list(ctx: TenantContext, query: { jobId?: string; limit?: number; cursor?: string } = {}) {
      assertPermission(ctx, "project:read");
      const page = await deps.handoffs.listPending(ctx, query);
      return { items: page.items.map(summary), nextCursor: page.nextCursor };
    },

    async get(ctx: TenantContext, taskId: string): Promise<AgentTaskView> {
      assertPermission(ctx, "project:read");
      const handoff = await deps.handoffs.get(ctx, taskId);
      if (!handoff) throw rejection("not_found");
      return view(handoff);
    },

    async submit(ctx: TenantContext, input: AgentTaskSubmitInput): Promise<AgentTaskSubmitResult> {
      assertPermission(ctx, "project:write");
      const handoff = await deps.handoffs.get(ctx, input.taskId);
      if (!handoff) throw rejection("not_found");
      const usage = ReportedUsage.safeParse(input.usage ?? {});
      if (!usage.success) {
        throw new StudixError("VALIDATION", "Invalid usage report", {
          details: { reason: "invalid_usage", issues: usage.error.issues.slice(0, 10) },
        });
      }
      const check = deps.validateOutput(handoff.stage, input.output);
      if (!check.ok) {
        throw new StudixError("VALIDATION", `The output does not match the ${handoff.stage} output schema`, {
          retryable: false,
          details: { reason: "invalid_output", taskId: handoff.id, issues: check.issues.slice(0, 20) },
          suggestedAction:
            "Fix the output to satisfy outputSchema from studix_get_agent_task and submit again.",
        });
      }
      const output = redactDeep(check.output);
      const result = await deps.handoffs.submit(ctx, {
        id: handoff.id,
        attempt: input.attempt,
        output,
        outputDigest: contentDigest(output),
        usage: usage.data,
        submittedBy: actorRef(ctx.actor),
      });
      if (result.status === "rejected") throw rejection(result.reason, result.handoff ?? handoff);
      return { task: summary(result.handoff), replayed: result.status === "duplicate" };
    },
  };
}

export type AgentHandoffService = ReturnType<typeof createAgentHandoffService>;
