import { CLAUDE_MODELS, listClaudeModels, listCodexModels, listPiCatalog } from "@studix/agent-runtime";
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
  const models = async (runtime: AgentRuntimeName, c: ListedConnection) =>
    runtime === "claude"
      ? claudeModels(c)
      : (runtime === "codex"
          ? listCodexModels()
          : runtime === "pi"
            ? (catalog.get(c.provider) ?? [])
            : []
        ).map((m) => ({ id: m.id, reasoning: m.reasoning }));

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
