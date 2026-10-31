import type { UsageEvent } from "@studix/core";
import { USAGE_KINDS } from "./usage-ledger.ts";

/** How an agent stage ran: inside the worker (harness) or on the MCP client's own agent (host). */
export type AgentRunMode = "harness" | "host";

/** Metadata every `agent.run` usage line carries (the stage runner adds `stage` and `attempt`). */
export interface AgentRunUsageMetadata {
  mode: AgentRunMode;
  runtime: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  /** Overrun approvals granted before this run (0 for the first run). */
  round: number;
  /** Set when the run stopped at this cap instead of finishing. */
  cap?: string;
}

export interface AgentStageUsage {
  stage: string;
  attempt: number;
  mode: AgentRunMode;
  runs: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}

export interface JobUsageSplit {
  /** Agent work: tokens and model spend of agent stages, per stage and attempt. */
  agent: {
    costCents: number;
    inputTokens: number;
    outputTokens: number;
    stages: AgentStageUsage[];
  };
  /** Everything else (planning decisions, media generation, render, storage). */
  media: { costCents: number };
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Split a job's usage events into agent spend (kind `agent.run`, broken down by stage and attempt) and the
 * rest, so token and agent cost never mix with media cost in reports.
 */
export function splitJobUsage(events: readonly UsageEvent[]): JobUsageSplit {
  const split: JobUsageSplit = {
    agent: { costCents: 0, inputTokens: 0, outputTokens: 0, stages: [] },
    media: { costCents: 0 },
  };
  const byStage = new Map<string, AgentStageUsage>();
  for (const event of events) {
    if (event.kind !== USAGE_KINDS.agentRun) {
      split.media.costCents += event.costCents;
      continue;
    }
    const meta = event.metadata ?? {};
    const stage = typeof meta.stage === "string" ? meta.stage : "unknown";
    const attempt = num(meta.attempt);
    const mode: AgentRunMode = meta.mode === "host" ? "host" : "harness";
    const key = `${stage}#${attempt}#${mode}`;
    const row = byStage.get(key) ?? {
      stage,
      attempt,
      mode,
      runs: 0,
      costCents: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    row.runs++;
    row.costCents += event.costCents;
    row.inputTokens += num(meta.inputTokens);
    row.outputTokens += num(meta.outputTokens);
    byStage.set(key, row);
    split.agent.costCents += event.costCents;
    split.agent.inputTokens += num(meta.inputTokens);
    split.agent.outputTokens += num(meta.outputTokens);
  }
  split.agent.stages = [...byStage.values()];
  return split;
}
