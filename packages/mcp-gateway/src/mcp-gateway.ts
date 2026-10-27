import { type ConnectorAdmin, createConnectorAdmin } from "./admin/connector-admin-service.ts";
import type { ToolCatalog } from "./catalog/tool-catalog.ts";
import {
  inspectTool,
  searchTools,
  type ToolInspectData,
  type ToolInspectInput,
  type ToolSearchData,
  type ToolSearchInput,
} from "./discovery/tool-discovery-service.ts";
import type { GatewayCallContext, GatewayResult } from "./execution/gateway-call-context.ts";
import { executeTool, type ToolExecuteData, type ToolExecuteInput } from "./execution/tool-executor.ts";
import { createGatewayRuntime, type McpGatewayDeps } from "./gateway-runtime.ts";

/** The MCP-in-MCP gateway: meta-tool handlers plus connector administration, all workspace-scoped. */
export interface McpGateway {
  search(call: GatewayCallContext, input: ToolSearchInput): Promise<GatewayResult<ToolSearchData>>;
  inspect(call: GatewayCallContext, input: ToolInspectInput): Promise<GatewayResult<ToolInspectData>>;
  execute(call: GatewayCallContext, input: ToolExecuteInput): Promise<GatewayResult<ToolExecuteData>>;
  connectors: ConnectorAdmin;
  /** Exposed for observability/tests (cache size); not needed by callers. */
  catalog: ToolCatalog;
}

export function createMcpGateway(deps: McpGatewayDeps): McpGateway {
  const rt = createGatewayRuntime(deps);
  return {
    search: (call, input) => searchTools(rt, call, input),
    inspect: (call, input) => inspectTool(rt, call, input),
    execute: (call, input) => executeTool(rt, call, input),
    connectors: createConnectorAdmin(rt),
    catalog: rt.catalog,
  };
}
