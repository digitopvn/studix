import { findPiModel } from "@studix/agent-runtime";
import { type ModelChoice, REASONING_EFFORTS, type ReasoningEffort, type TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { AppDeps } from "./app-deps.ts";

/** `provider/modelId` as the workspace catalog lists it, for example `anthropic/claude-sonnet-4-5`. */
export const AgentModelRef = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{1,60}\/[A-Za-z0-9._:/@-]{1,200}$/, "Use provider/modelId");
export const ReasoningEffortInput = z.enum(REASONING_EFFORTS);

export interface AgentModelSelection {
  choice?: ModelChoice;
  reasoningEffort?: ReasoningEffort;
}

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

/**
 * Checks a job's requested agent model and reasoning effort against the workspace catalog: the model must
 * be in the Pi catalog and served by a usable Pi connection of the workspace, and an effort needs a
 * reasoning model. Without a model, the effort is checked against the workspace's default Pi model.
 */
export async function resolveAgentModelSelection(
  deps: Pick<AppDeps, "providers" | "modelPreferences">,
  ctx: TenantContext,
  input: { model?: string; reasoningEffort?: ReasoningEffort },
): Promise<AgentModelSelection> {
  const effort = input.reasoningEffort;
  if (!input.model) {
    if (!effort || effort === "off" || !deps.modelPreferences)
      return effort ? { reasoningEffort: effort } : {};
    const preview = await deps.modelPreferences.preview(ctx, { runtime: "pi" });
    const pref = preview.selection?.preference;
    const model = pref ? findPiModel(pref.provider, pref.modelId) : undefined;
    if (pref && model) assertEffort(`${pref.provider}/${pref.modelId}`, model.reasoning, effort);
    return { reasoningEffort: effort };
  }
  const { provider, modelId, model } = catalogModel(input.model);
  assertEffort(input.model, model.reasoning, effort);
  if (!deps.providers) {
    throw new StudixError("UNAVAILABLE", "Provider connections are not configured on this Studix server", {
      retryable: false,
      suggestedAction: "Omit model to use the default agent model.",
    });
  }
  const { connections } = await deps.providers.list(ctx);
  const candidates = connections.filter(
    (c) => c.provider === provider && c.runtimes.includes("pi") && c.status !== "invalid",
  );
  const connection = candidates.find((c) => c.ownedByMe) ?? candidates.find((c) => c.owner === "workspace");
  if (!connection) {
    throw invalid(
      `No ${provider} connection of this workspace serves the Pi runtime`,
      { model: input.model },
      "Add a key for this provider in the dashboard (AI & Providers) and enable it for Pi.",
    );
  }
  await deps.providers.assertUsable(ctx, connection.id, "pi");
  return {
    choice: { connectionId: connection.id, provider, modelId },
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

/** Same checks for a model the host says it used, without needing a connection of its own. */
export function assertReportedModel(model: string | undefined, effort: ReasoningEffort | undefined): void {
  if (!model) return;
  const { model: entry } = catalogModel(model);
  assertEffort(model, entry.reasoning, effort);
}
