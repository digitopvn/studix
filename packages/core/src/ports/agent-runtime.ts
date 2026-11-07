import type {
  AgentRuntimeName,
  ReasoningEffort,
  ResolvedModelSnapshot,
} from "../entities/model-preference.ts";
import type { FundingSource } from "../entities/telemetry.ts";
import type { TenantContext } from "../tenant.ts";

export interface AgentToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  inputSchema: Record<string, unknown>;
}

/**
 * One normalized, already-redacted step of a live agent run, the same for every runtime. Text and reasoning
 * come as deltas (a runtime that only has whole blocks sends each block as one delta).
 */
export type AgentStreamEvent =
  | { type: "message"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; id: string; name: string; args?: unknown }
  | { type: "tool_end"; id: string; name: string; ok: boolean; result?: string }
  | {
      type: "usage";
      turns: number;
      inputTokens: number;
      outputTokens: number;
      costCents: number;
      model?: string;
    };

export interface AgentInputFile {
  /** Tenant-relative storage key, for example `assets/<id>/v1/out.mp4`. */
  storageKey: string;
  /** Path under /work/in, for example `builder/out.mp4`; relative, without `..`. */
  path: string;
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
  /**
   * Stored files the agent reads, copied to /work/in/<path> before it starts; the sandbox never fetches them
   * over the network. Needs a sandboxed (tool-using) run.
   */
  inputFiles?: AgentInputFile[];
  signal?: AbortSignal;
  /** Live events of the run; a runtime calls it best-effort and never waits on it. */
  onEvent?: (event: AgentStreamEvent) => void;
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
  /** The runtime, connection and effort the run actually used, for the stage's usage line. Never a secret. */
  route?: AgentRunRoute;
}

export interface AgentRunRoute {
  runtime: AgentRuntimeName;
  connectionId?: string;
  reasoningEffort?: ReasoningEffort;
}

/** The limit an agent run stopped at; carried as `details.cap` on the run's error. */
export const AGENT_CAPS = ["turns", "tokens", "cost", "time"] as const;
export type AgentCap = (typeof AGENT_CAPS)[number];

/** Bounded agent execution boundary (e.g. Pi). Must honour budget, turns, tokens, deadline and signal. */
export interface AgentRuntime {
  readonly id: string;
  run(ctx: TenantContext, task: AgentTask): Promise<AgentRunResult>;
}
