import type { ResolvedModelSnapshot } from "../entities/model-preference.ts";
import type { FundingSource } from "../entities/telemetry.ts";
import type { TenantContext } from "../tenant.ts";

export interface AgentToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface AgentTask {
  /** Skill or template id that framed the task. */
  skill: string;
  instructions: string;
  input: Record<string, unknown>;
  tools?: AgentToolDefinition[];
  /** JSON Schema the final output must satisfy. */
  outputSchema?: Record<string, unknown>;
  maxCostCents: number;
  maxTurns: number;
  /** Cap on input plus output tokens; omitted means only the cost cap bounds tokens. */
  maxTokens?: number;
  deadlineAt?: Date;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  output: unknown;
  turns: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  /** Which stored connection ran the task, so the job layer can record it and pin retries to it. */
  resolved?: {
    connectionId: string;
    snapshot?: ResolvedModelSnapshot;
    /** True when a consented fallback ran instead of the primary choice. */
    usedFallback: boolean;
  };
  /** The provider execution recorded for this run, so its usage line is billed against that record. */
  providerExecutionId?: string;
  /** Who paid the provider for this run (the connection's owner); `operator` when omitted. */
  funding?: FundingSource;
}

/** The limit an agent run stopped at; carried as `details.cap` on the run's error. */
export const AGENT_CAPS = ["turns", "tokens", "cost", "time"] as const;
export type AgentCap = (typeof AGENT_CAPS)[number];

/** Bounded agent execution boundary (e.g. Pi). Must honour budget, turns, tokens, deadline and signal. */
export interface AgentRuntime {
  readonly id: string;
  run(ctx: TenantContext, task: AgentTask): Promise<AgentRunResult>;
}
