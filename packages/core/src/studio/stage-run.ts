import type { Stage } from "../entities/job.ts";
import { AGENT_RUNTIMES, REASONING_EFFORTS, type ReasoningEffort } from "../entities/model-preference.ts";
import type { UsageEvent } from "../entities/telemetry.ts";

/**
 * What one stage attempt ran on and what it cost, summed from its usage lines. `runtime` is `function` for a
 * stage that ran no agent (plain code such as brief, compose or finalize), `host` when the MCP client's own
 * agent did the work and `planner` for the legacy fixed planner's model calls. A connection is named by its
 * label only.
 */
export interface StageRunView {
  runtime: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  connectionId?: string;
  connectionLabel?: string;
  costCents: number;
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Usage lines recorded by the stage runner carry `metadata.stage` and `metadata.attempt` (the job attempt). */
export function stageRunOf(
  stage: Pick<Stage, "name" | "attempt">,
  usage: readonly UsageEvent[],
): StageRunView {
  const run: StageRunView = { runtime: "function", costCents: 0 };
  for (const line of usage) {
    const m = line.metadata ?? {};
    if (m.stage !== stage.name || m.attempt !== stage.attempt) continue;
    run.costCents += line.costCents;
    const decision = line.kind === "provider.decision";
    if (m.mode !== "harness" && m.mode !== "host" && !decision) continue;
    // Older lines name the runtime by its implementation id; the agent runtime name is the newer field.
    run.runtime = decision
      ? run.runtime === "function"
        ? "planner"
        : run.runtime
      : m.mode === "host"
        ? "host"
        : (AGENT_RUNTIMES.find((r) => r === m.agentRuntime) ??
          AGENT_RUNTIMES.find((r) => str(m.runtime)?.startsWith(r)) ??
          str(m.runtime) ??
          "agent");
    run.model = str(m.model) ?? run.model;
    const effort = REASONING_EFFORTS.find((e) => e === m.reasoningEffort);
    if (effort) run.reasoningEffort = effort;
    const connectionId = str(m.connectionId);
    if (connectionId) run.connectionId = connectionId;
    run.inputTokens = (run.inputTokens ?? 0) + (num(m.inputTokens) ?? 0);
    run.outputTokens = (run.outputTokens ?? 0) + (num(m.outputTokens) ?? 0);
    run.turns = (run.turns ?? 0) + (num(m.turns) ?? 0);
  }
  return run;
}
