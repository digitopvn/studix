import type { ActorRef, TenantOwned } from "./common.ts";

/**
 * `pending`: waiting for the host agent. `submitted`: a valid output was accepted. `expired`: the host
 * did not submit within the time limit. `cancelled`: the job stopped waiting for it.
 */
export const AGENT_HANDOFF_STATUSES = ["pending", "submitted", "expired", "cancelled"] as const;
export type AgentHandoffStatus = (typeof AGENT_HANDOFF_STATUSES)[number];

/**
 * Limits of one agent stage run, the same in both modes. In the harness every one is a hard cap; a host
 * agent receives them with the task and only the time limit is enforced by Studix (by expiring the task).
 */
export interface AgentStageLimits {
  maxTurns: number;
  /** Input plus output tokens. */
  maxTokens: number;
  maxCostCents: number;
  timeoutMs: number;
  /** Tool names the agent may call; everything else is denied. */
  tools: string[];
}

/** Usage a host agent reports with its output (Studix pays nothing for host work). */
export interface AgentHandoffUsage {
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

/**
 * A creative stage handed to the MCP host agent: what to do, the stage input, the JSON Schema the output
 * must satisfy and the limits. The job is parked in `waiting_host` until a valid output is submitted for
 * the attempt the task was opened in.
 */
export interface AgentHandoff extends TenantOwned {
  jobId: string;
  stage: string;
  /** Job attempt that opened the task; a submission must name it. */
  attempt: number;
  /** Overrun approvals granted before this task was opened (0 for the first run). */
  round: number;
  status: AgentHandoffStatus;
  instructions: string;
  input: Record<string, unknown>;
  /** JSON Schema (draft 2020-12) of the stage output. */
  outputSchema: Record<string, unknown>;
  limits: AgentStageLimits;
  expiresAt: Date;
  output?: Record<string, unknown>;
  /** Digest of the accepted output; a repeated submission with the same digest is a no-op. */
  outputDigest?: string;
  usage?: AgentHandoffUsage;
  submittedBy?: ActorRef;
  submittedAt?: Date;
  updatedAt: Date;
}
