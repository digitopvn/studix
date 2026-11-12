import { claudeModelReasoning, findPiModel, listCodexModels } from "@studix/agent-runtime";
import {
  AGENT_ROLES,
  AGENT_RUNTIMES,
  type JobAgentRoles,
  type JobAgentSelection,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type TenantContext,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { AppDeps } from "./app-deps.ts";

/** `provider/modelId` as the workspace catalog lists it, for example `anthropic/claude-sonnet-4-5`. */
export const AgentModelRef = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{1,60}\/[A-Za-z0-9._:/@-]{1,200}$/, "Use provider/modelId");
export const ReasoningEffortInput = z.enum(REASONING_EFFORTS);

function invalid(message: string, details: Record<string, unknown>, suggestedAction: string): StudixError {
  return new StudixError("VALIDATION", message, { retryable: false, details, suggestedAction });
}

/** Parses `provider/modelId` and checks the Pi catalog; returns the catalog entry. */
function catalogModel(ref: string) {
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const model = findPiModel(provider, modelId);
  if (!model) {
    throw invalid(
      `The model ${ref} is not in the workspace catalog`,
      { model: ref },
      "List models with studix_inspect or the dashboard (AI & Providers).",
    );
  }
  return { provider, modelId, model };
}

function assertEffort(ref: string, reasoning: boolean, effort: ReasoningEffort | undefined): void {
  if (effort && effort !== "off" && !reasoning) {
    throw invalid(
      `The model ${ref} does not support reasoning effort ${effort}`,
      { model: ref, reasoningEffort: effort },
      "Omit reasoningEffort, set it to off, or pick a reasoning model.",
    );
  }
}

/** The agent a job runs on: a runtime, the provider connection that pays, and optionally model and effort. */
export const AgentInput = z
  .object({
    runtime: z.enum(AGENT_RUNTIMES),
    providerConnectionId: z.string().min(1).max(100),
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:/@-]{1,200}$/)
      .optional(),
    reasoningEffort: ReasoningEffortInput.optional(),
  })
  .strict();
export type AgentInput = z.infer<typeof AgentInput>;

/**
 * Checks a job's requested agent: the connection must be usable by the runtime, the model must be one that
 * runtime runs on that connection's provider (the Pi catalog, or the Codex models), and an effort needs a
 * reasoning model. Returns what the job stores, so the worker never has to choose again.
 */
export async function resolveAgentSelection(
  deps: Pick<AppDeps, "providers" | "modelPreferences">,
  ctx: TenantContext,
  agent: AgentInput,
  /** False when the worker will not resolve a Pi default for this job (host mode, or a planner runs it). */
  needsDefault = true,
): Promise<JobAgentSelection> {
  if (!deps.providers) {
    throw new StudixError("UNAVAILABLE", "Provider connections are not configured on this Studix server", {
      retryable: false,
      suggestedAction: "Omit agent to use the default agent model.",
    });
  }
  const { connections } = await deps.providers.list(ctx);
  const connection = connections.find((c) => c.id === agent.providerConnectionId);
  if (!connection) {
    throw invalid(
      "This provider connection does not exist or is not visible to you",
      { providerConnectionId: agent.providerConnectionId },
      "List connections with studix_list_agent_runtimes.",
    );
  }
  await deps.providers.assertUsable(ctx, connection.id, agent.runtime);
  const effort = agent.reasoningEffort;
  // `provider/modelId` is accepted too when it names the connection's provider.
  const prefix = `${connection.provider}/`;
  const modelId = agent.model?.startsWith(prefix) ? agent.model.slice(prefix.length) : agent.model;
  if (modelId) {
    const ref = `${connection.provider}/${modelId}`;
    const reasoning =
      agent.runtime === "pi"
        ? findPiModel(connection.provider, modelId)?.reasoning
        : agent.runtime === "codex"
          ? listCodexModels().find((m) => m.id === modelId)?.reasoning
          : /^claude-[a-z0-9.-]{1,80}$/.test(modelId)
            ? claudeModelReasoning(modelId)
            : undefined;
    if (reasoning === undefined) {
      throw invalid(
        `The model ${ref} is not one the ${agent.runtime} runtime runs`,
        { model: ref, runtime: agent.runtime },
        "List models with studix_list_agent_runtimes.",
      );
    }
    assertEffort(ref, reasoning, effort);
  } else if (agent.runtime === "pi" && needsDefault) {
    await assertPiDefaultModel(deps, ctx);
  }
  return {
    runtime: agent.runtime,
    connectionId: connection.id,
    provider: connection.provider,
    ...(modelId ? { modelId } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

/**
 * A Pi agent without a model runs on the `default` preference the worker resolves for this caller: no run
 * stage uses another entry. Personal defaults apply only to their owner's own jobs, so a workspace API key
 * sees workspace defaults alone; refusing here beats a job that fails at its first agent stage.
 */
async function assertPiDefaultModel(
  deps: Pick<AppDeps, "modelPreferences">,
  ctx: TenantContext,
): Promise<void> {
  if (!deps.modelPreferences) return;
  const preview = await deps.modelPreferences.preview(ctx, { runtime: "pi", stage: "default" });
  if (preview.selection) return;
  throw new StudixError("UNAVAILABLE", "No default model applies to this caller on the pi runtime", {
    retryable: false,
    details: { reason: "no_model_selected" },
    suggestedAction:
      "Pass agent.model, or have a workspace admin add a workspace-owned Pi key and choose the default model in Settings → AI & Providers. A personal default applies only to jobs its owner starts.",
  });
}

/**
 * A job created without an agent runs its agent stages on the caller's preference, as the worker's `choose()`
 * does: a Pi or a Claude `default` entry, whichever is more specific (Pi on a tie). Either one is enough here,
 * so a job the worker would run is never refused; no operator model is ever substituted. Host mode, a planner
 * and a ready spec never reach an agent stage that needs one, and a pack with a template fallback never fails
 * for lack of a model, so those are not checked.
 */
export async function assertDefaultAgentModel(
  deps: Pick<AppDeps, "modelPreferences">,
  ctx: TenantContext,
  job: {
    pack: { needsAgentModel?: boolean };
    agent: unknown;
    planner: unknown;
    agentMode: "harness" | "host" | undefined;
    spec: unknown;
  },
): Promise<void> {
  if (!job.pack.needsAgentModel || job.agent || job.planner || job.spec !== undefined) return;
  if (job.agentMode === "host" || !deps.modelPreferences) return;
  // The listing holds the caller's own preferences and the workspace's, of any runtime (`preview` knows Pi only).
  const { preferences } = await deps.modelPreferences.list(ctx);
  if (preferences.some((p) => p.stage === "default")) return;
  throw new StudixError("UNAVAILABLE", "No default agent model applies to this caller", {
    retryable: false,
    details: { reason: "no_model_selected" },
    suggestedAction:
      "Pass agent (with agent.model for Pi), submit with agentMode 'host', or have a workspace admin choose the workspace default model in Settings → AI & Providers. A personal default applies only to jobs its owner starts.",
  });
}

/** Same checks for a model the host says it used, without needing a connection of its own. */
export function assertReportedModel(model: string | undefined, effort: ReasoningEffort | undefined): void {
  if (!model) return;
  const { model: entry } = catalogModel(model);
  assertEffort(model, entry.reasoning, effort);
}

/** Optional role agents: director/builder/qa for skill-agent, director only (premium tier) for motion-graphic; each is checked like `agent`. */
export const AgentRolesInput = z
  .object({ director: AgentInput.optional(), builder: AgentInput.optional(), qa: AgentInput.optional() })
  .strict();
export type AgentRolesInput = z.infer<typeof AgentRolesInput>;

export async function resolveAgentRoles(
  deps: Pick<AppDeps, "providers" | "modelPreferences">,
  ctx: TenantContext,
  roles: AgentRolesInput | undefined,
  /** False in host mode; a role outranks a planner, so a planner does not waive the check. */
  needsDefault = true,
): Promise<JobAgentRoles | undefined> {
  if (!roles) return undefined;
  const out: JobAgentRoles = {};
  for (const role of AGENT_ROLES) {
    const agent = roles[role];
    if (agent) out[role] = await resolveAgentSelection(deps, ctx, agent, needsDefault);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
