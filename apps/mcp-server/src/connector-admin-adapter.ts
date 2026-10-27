import type { TenantContext } from "@studix/core";
import type {
  ConnectorRepository,
  ConnectorAdmin as GatewayConnectorAdmin,
  ConnectorView as GatewayConnectorView,
} from "@studix/mcp-gateway";
import type { ConnectorAdmin, ConnectorStatus, ConnectorView } from "./ports.ts";

/** Dashboard status: a failed last check wins over enabled; revoked connectors read as disabled. */
function statusOf(view: GatewayConnectorView): ConnectorStatus {
  if (view.status !== "enabled") return "disabled";
  return view.lastTest?.ok === false ? "error" : "active";
}

function toView(view: GatewayConnectorView): ConnectorView {
  const failure = view.lastTest?.ok === false ? view.lastTest.error?.message : undefined;
  return {
    id: view.id,
    name: view.name,
    url: view.url,
    status: statusOf(view),
    toolCount: view.toolCount,
    ...(view.lastTest ? { lastCheckedAt: view.lastTest.at } : {}),
    ...(failure ? { lastError: failure } : {}),
    createdAt: view.createdAt,
  };
}

/**
 * The app's ConnectorAdmin port over the gateway's admin service. The gateway enforces permissions,
 * URL policy and tenancy; this adapter only reshapes records for the dashboard (`test` = refresh).
 */
export function createConnectorAdminAdapter(deps: {
  admin: GatewayConnectorAdmin;
  connectors: Pick<ConnectorRepository, "get">;
}): ConnectorAdmin {
  const call = (tenant: TenantContext) => ({ tenant });
  return {
    list: async (ctx) => (await deps.admin.list(call(ctx))).map(toView),
    add: async (ctx, input) => toView(await deps.admin.add(call(ctx), input)),
    disable: async (ctx, id) => toView(await deps.admin.disable(call(ctx), id)),
    async test(ctx, id) {
      const { connector, result } = await deps.admin.refresh(call(ctx), id);
      if (!result.ok) return { ok: false, error: result.error?.message ?? "Connector check failed" };
      const stored = await deps.connectors.get(ctx, id);
      return {
        ok: true,
        toolCount: connector.toolCount,
        tools: (stored?.tools ?? []).map((t) => `${connector.name}.${t.name}`),
      };
    },
  };
}
