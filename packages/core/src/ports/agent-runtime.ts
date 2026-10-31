import type { ResolvedModelSnapshot } from "../entities/provider-connection.ts";
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
  /** Which stored connection actually ran the task, so the job layer can record it and pin retries to it. */
  resolved?: {
    connectionId: string;
    snapshot?: ResolvedModelSnapshot;
    /** True when a consented fallback ran instead of the primary choice. */
    usedFallback: boolean;
  };
}

/** Bounded agent execution boundary (e.g. Pi). Must honour budget, turns, deadline and signal. */
export interface AgentRuntime {
  readonly id: string;
  run(ctx: TenantContext, task: AgentTask): Promise<AgentRunResult>;
}
