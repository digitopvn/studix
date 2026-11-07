import {
  CLAUDE_MODELS,
  hasLivePiModels,
  listClaudeModels,
  listCodexModels,
  listPiCatalog,
  listPiModelsLive,
} from "@studix/agent-runtime";
import type { ProviderConnectionService } from "@studix/auth";
import { AGENT_RUNTIMES, type AgentRuntimeName, actorRef, type TenantContext } from "@studix/core";

type ListedConnection = Awaited<ReturnType<ProviderConnectionService["list"]>>["connections"][number];

/** Agent runtimes with the caller's usable connections (no secrets) and their models. */
export async function listAgentRuntimes(
  providers: Pick<ProviderConnectionService, "list" | "resolveForExecution"> | undefined,
  tenant: TenantContext,
) {
  const { connections } = providers ? await providers.list(tenant) : { connections: [] };
  const catalog = new Map(listPiCatalog().map((p) => [p.id, p.models] as const));

  // An Anthropic API key lists its models live; a subscription token, or a key the caller may not
  // open, gets the static current list.
  const claudeModels = async (c: ListedConnection) => {
    if (!providers || c.authMethod !== "api_key" || c.provider !== "anthropic") return [...CLAUDE_MODELS];
    try {
      const { apiKey } = await providers.resolveForExecution(tenant, {
        connectionId: c.id,
        requestedBy: actorRef(tenant.actor),
        runtime: "claude",
      });
      return await listClaudeModels({ cacheKey: c.id, apiKey });
    } catch {
      return [...CLAUDE_MODELS];
    }
  };
  // Same for Pi: an Anthropic or OpenAI key lists its models live, priced from the catalog or OpenRouter.
  const piModels = async (c: ListedConnection) => {
    const fallback = catalog.get(c.provider) ?? [];
    if (!providers || c.authMethod !== "api_key" || !hasLivePiModels(c.provider)) return fallback;
    try {
      const { apiKey } = await providers.resolveForExecution(tenant, {
        connectionId: c.id,
        requestedBy: actorRef(tenant.actor),
        runtime: "pi",
      });
      return await listPiModelsLive({ cacheKey: c.id, provider: c.provider, apiKey, catalog: fallback });
    } catch {
      return fallback;
    }
  };
  const models = async (runtime: AgentRuntimeName, c: ListedConnection) =>
    runtime === "claude"
      ? claudeModels(c)
      : (runtime === "codex" ? listCodexModels() : runtime === "pi" ? await piModels(c) : []).map((m) => ({
          id: m.id,
          reasoning: m.reasoning,
        }));

  return Promise.all(
    AGENT_RUNTIMES.map(async (runtime) => ({
      runtime,
      connections: await Promise.all(
        connections
          .filter((c) => c.runtimes.includes(runtime) && c.status !== "invalid")
          .map(async (c) => ({
            providerConnectionId: c.id,
            provider: c.provider,
            label: c.label,
            owner: c.owner,
            authMethod: c.authMethod,
            status: c.status,
            models: await models(runtime, c),
          })),
      ),
    })),
  );
}
