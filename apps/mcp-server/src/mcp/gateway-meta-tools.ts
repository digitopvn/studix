import type { McpServer } from "@modelcontextprotocol/server";
import { GATEWAY_META_TOOLS, type McpGateway } from "@studix/mcp-gateway";
import { withSpan } from "@studix/observability";
import { toStudixError } from "@studix/shared";
import type { MetaToolDeps, RegisterMetaTools } from "../ports.ts";
import { errorEnvelope, okEnvelope, ToolEnvelopeSchema } from "./tool-envelope.ts";

/** Names of the gateway meta-tools, listed by `studix_inspect` when the gateway is wired. */
export const META_TOOL_NAMES = GATEWAY_META_TOOLS.map((t) => t.name as string);

function traceIdOf(err: ReturnType<typeof toStudixError>, fallback: string): string {
  const traced = err.details?.traceId;
  return typeof traced === "string" ? traced : fallback;
}

/**
 * Register `studix_tool_search`, `studix_tool_inspect` and `studix_tool_execute` on the per-request server
 * with the same `{status, data, next, error?, traceId}` envelope as the native tools. The gateway call
 * context comes from authentication only: tenant from the API key, depth from the inbound hop header.
 */
export function createGatewayMetaTools(gateway: McpGateway): RegisterMetaTools {
  return (server: McpServer, deps: MetaToolDeps) => {
    const call = { tenant: deps.tenant, depth: deps.gatewayDepth };
    for (const tool of GATEWAY_META_TOOLS) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: ToolEnvelopeSchema,
          annotations: { ...tool.annotations, idempotentHint: tool.annotations.readOnlyHint },
        },
        async (args: unknown) =>
          withSpan(`mcp.tool ${tool.name}`, { attributes: { "studix.tool": tool.name } }, async () => {
            try {
              const result = await tool.run(gateway, call, args);
              const next = result.next.map((n) => ({ ...n, arguments: n.arguments ?? {} }));
              return okEnvelope(result.data as object, next, result.traceId);
            } catch (error) {
              const err = toStudixError(error);
              deps.logger[err.code === "INTERNAL" ? "error" : "warn"]("mcp meta-tool failed", {
                tool: tool.name,
                code: err.code,
                error: err.message,
                workspaceId: deps.tenant.workspaceId,
              });
              return errorEnvelope(err, traceIdOf(err, deps.traceId));
            }
          }),
      );
    }
  };
}
