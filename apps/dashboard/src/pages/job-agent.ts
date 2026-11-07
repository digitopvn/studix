import type { JobAgent, StageRun } from "../api-client.ts";

/** Values of the `agent` filter, as the API names them (see `jobAgent` in @studix/core). */
export const JOB_AGENT_OPTIONS = ["claude", "codex", "pi", "host", "planner", "none"] as const;

const RUNTIME_LABELS: Record<string, string> = {
  host: "host (MCP client agent)",
  planner: "legacy planner",
  none: "none (MCP/external)",
};

/** "pi · deepseek-v4.1-flash · high"; defaults are shown as such so a blank never looks like missing data. */
export function formatJobAgent(agent: JobAgent | undefined): string {
  if (!agent) return "-";
  const label = RUNTIME_LABELS[agent.runtime];
  if (label) return label;
  return [agent.runtime, agent.model ?? "default model", agent.reasoningEffort ?? "default effort"].join(
    " · ",
  );
}

export function jobAgentOptionLabel(runtime: string): string {
  return RUNTIME_LABELS[runtime] ?? runtime;
}

/** A stage's runtime line: "claude · claude-opus-5-5 · xhigh", "legacy planner · <model>", or "function" for plain code. */
export function formatStageRuntime(run: Pick<StageRun, "runtime" | "model" | "reasoningEffort">): string {
  if (run.runtime === "function") return "function";
  if (run.runtime === "host") return RUNTIME_LABELS.host!;
  if (run.runtime === "planner") return [RUNTIME_LABELS.planner, run.model].filter(Boolean).join(" · ");
  return [run.runtime, run.model ?? "default model", run.reasoningEffort ?? "default effort"].join(" · ");
}

/** "12.5c · 18,400 tok · 6 turns · via Team key"; parts that were not recorded are left out. */
export function formatStageSpend(
  run: Pick<StageRun, "costCents" | "inputTokens" | "outputTokens" | "turns" | "connectionLabel">,
): string {
  const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  return [
    formatCents(run.costCents),
    run.inputTokens !== undefined || run.outputTokens !== undefined
      ? `${tokens.toLocaleString()} tok`
      : undefined,
    run.turns ? `${run.turns} turns` : undefined,
    run.connectionLabel ? `via ${run.connectionLabel}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Cents with up to two decimals: token-priced runs cost fractions of a cent. */
export function formatCents(cents: number): string {
  return `${Number(cents.toFixed(2))}c`;
}
