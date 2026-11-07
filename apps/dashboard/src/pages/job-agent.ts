import type { JobAgent } from "../api-client.ts";

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
