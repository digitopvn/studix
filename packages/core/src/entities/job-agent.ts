import type { Job } from "./job.ts";
import {
  AGENT_RUNTIMES,
  type AgentRuntimeName,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "./model-preference.ts";

/**
 * Who ran a job's creative stages, read from the payload the job was created with:
 * - an agent runtime (`claude`, `codex`, `pi`) from `payload.agent`;
 * - `host`: `agentMode: "host"`, the MCP client's own agent through the handoff tools;
 * - `planner`: the legacy fixed Claude planner (`payload.planner` without `agent`);
 * - `none`: no Studix agent, e.g. a job driven over MCP by an external tool or a render.
 */
export const JOB_AGENT_RUNTIMES = [...AGENT_RUNTIMES, "host", "planner", "none"] as const;
export type JobAgentRuntime = (typeof JOB_AGENT_RUNTIMES)[number];

/** Display view of a job's agent. Carries no connection id or secret. */
export interface JobAgentView {
  runtime: JobAgentRuntime;
  provider?: string;
  /** Absent when the runtime's default model was used. */
  model?: string;
  /** Absent when the runtime's default effort was used. */
  reasoningEffort?: ReasoningEffort;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** Keep in step with the SQL in the database job repository (`jobAgentRuntimeSql`, `jobAgentModelSql`). */
export function jobAgent(job: Pick<Job, "payload">): JobAgentView {
  const payload = job.payload ?? {};
  if (payload.agentMode === "host") return { runtime: "host" };
  const agent = record(payload.agent);
  const runtime = agent?.runtime;
  if (agent && (AGENT_RUNTIMES as readonly unknown[]).includes(runtime)) {
    const effort = agent.reasoningEffort;
    return {
      runtime: runtime as AgentRuntimeName,
      ...(text(agent.provider) ? { provider: text(agent.provider) } : {}),
      ...(text(agent.modelId) ? { model: text(agent.modelId) } : {}),
      ...((REASONING_EFFORTS as readonly unknown[]).includes(effort)
        ? { reasoningEffort: effort as ReasoningEffort }
        : {}),
    };
  }
  if (record(payload.planner)) return { runtime: "planner", provider: "anthropic" };
  return { runtime: "none" };
}
