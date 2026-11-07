import { listCodexModels, listPiCatalog } from "@studix/agent-runtime";
import type { ProviderConnectionService } from "@studix/auth";
import { AGENT_RUNTIMES, type AgentRuntimeName, type TenantContext } from "@studix/core";

/** Agent runtimes with the caller's usable connections (no secrets) and their models. */
export async function listAgentRuntimes(
  providers: Pick<ProviderConnectionService, "list"> | undefined,
  tenant: TenantContext,
) {
  const { connections } = providers ? await providers.list(tenant) : { connections: [] };
  const catalog = new Map(listPiCatalog().map((p) => [p.id, p.models] as const));
  const models = (runtime: AgentRuntimeName, provider: string) =>
    (runtime === "codex" ? listCodexModels() : runtime === "pi" ? (catalog.get(provider) ?? []) : []).map(
      (m) => ({ id: m.id, reasoning: m.reasoning }),
    );
  return AGENT_RUNTIMES.map((runtime) => ({
    runtime,
    connections: connections
      .filter((c) => c.runtimes.includes(runtime) && c.status !== "invalid")
      .map((c) => ({
        providerConnectionId: c.id,
        provider: c.provider,
        label: c.label,
        owner: c.owner,
        authMethod: c.authMethod,
        status: c.status,
        models: models(runtime, c.provider),
      })),
  }));
}
