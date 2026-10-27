import { StudixError } from "@studix/shared";
import { z } from "zod";
import { scoreEntry } from "../catalog/tool-catalog.ts";
import { qualifyToolName } from "../catalog/tool-normalizer.ts";
import {
  type GatewayCallContext,
  type GatewayResult,
  UNTRUSTED_NOTICE,
} from "../execution/gateway-call-context.ts";
import { authorizeCall, currentTraceId, type GatewayRuntime, loadConnectorTool } from "../gateway-runtime.ts";
import {
  evaluateToolPermission,
  GATEWAY_PERMISSIONS,
  isMutatingTool,
} from "../policy/tool-permission-policy.ts";
import type {
  ConnectorStatus,
  ConnectorToolAnnotations,
  ConnectorToolFlag,
} from "../registry/connector-types.ts";

export const ToolSearchInput = z.object({
  query: z
    .string()
    .max(200)
    .default("")
    .describe("Words describing the capability you need; empty lists all."),
  server: z.string().max(40).optional().describe("Restrict results to one connector name."),
  limit: z.number().int().min(1).max(25).default(10),
});
export type ToolSearchInput = z.input<typeof ToolSearchInput>;

export const ToolInspectInput = z.object({
  tool: z.string().min(3).max(200).describe("Qualified tool name `connector.tool` from studix_tool_search."),
});
export type ToolInspectInput = z.input<typeof ToolInspectInput>;

export interface ToolSearchHit {
  tool: string;
  connector: string;
  title?: string;
  summary: string;
  readOnly: boolean;
  requiresApproval: boolean;
  flags: ConnectorToolFlag[];
}

export interface ToolSearchData {
  query: string;
  results: ToolSearchHit[];
  notice: string;
}

export interface ToolInspectData {
  tool: string;
  connector: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ConnectorToolAnnotations;
  permission: { allowed: true; requiresApproval: boolean };
  availability: { status: ConnectorStatus; lastRefreshedAt?: string };
  flags: ConnectorToolFlag[];
  notice: string;
}

/** Parse boundary input with zod and convert failures to VALIDATION errors. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new StudixError("VALIDATION", "Invalid arguments", {
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  return parsed.data;
}

/** `studix_tool_search`: permitted tools only (denied, disabled and revoked tools never appear). */
export async function searchTools(
  rt: GatewayRuntime,
  call: GatewayCallContext,
  input: ToolSearchInput,
): Promise<GatewayResult<ToolSearchData>> {
  authorizeCall(call, GATEWAY_PERMISSIONS.discover);
  const { query, server, limit } = parseInput(ToolSearchInput, input);
  const connectors = (await rt.connectors.list(call.tenant, { status: "enabled" })).filter(
    (c) => server === undefined || c.name === server,
  );
  const scored: Array<{ hit: ToolSearchHit; score: number }> = [];
  for (const connector of connectors) {
    for (const entry of rt.catalog.entriesFor(connector)) {
      if (!evaluateToolPermission(connector, entry.tool.name).allowed) continue;
      const score = scoreEntry(entry, query);
      if (score <= 0) continue;
      const mutating = isMutatingTool(entry.tool);
      scored.push({
        score,
        hit: {
          tool: entry.qualifiedName,
          connector: entry.connectorName,
          ...(entry.tool.title ? { title: entry.tool.title } : {}),
          summary: entry.summary,
          readOnly: !mutating,
          requiresApproval: mutating,
          flags: entry.tool.flags,
        },
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.hit.tool.localeCompare(b.hit.tool));
  const results = scored.slice(0, limit).map((s) => s.hit);
  const top = results[0];
  return {
    data: { query, results, notice: UNTRUSTED_NOTICE },
    next: top
      ? [
          {
            tool: "studix_tool_inspect",
            arguments: { tool: top.tool },
            reason: "Read the input schema before executing.",
          },
        ]
      : [],
    traceId: currentTraceId(),
  };
}

/** `studix_tool_inspect`: actual input schema, annotations, permission and availability of one tool. */
export async function inspectTool(
  rt: GatewayRuntime,
  call: GatewayCallContext,
  input: ToolInspectInput,
): Promise<GatewayResult<ToolInspectData>> {
  authorizeCall(call, GATEWAY_PERMISSIONS.discover);
  const { tool: qualified } = parseInput(ToolInspectInput, input);
  const { connector, tool } = await loadConnectorTool(rt, call, qualified);
  const verdict = evaluateToolPermission(connector, tool.name);
  if (!verdict.allowed) {
    throw new StudixError("FORBIDDEN", `Tool ${qualified} is not available (${verdict.reason})`, {
      retryable: false,
      suggestedAction: "Ask a workspace admin to enable the connector or grant this tool.",
    });
  }
  const mutating = isMutatingTool(tool);
  const name = qualifyToolName(connector.name, tool.name);
  return {
    data: {
      tool: name,
      connector: connector.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      permission: { allowed: true, requiresApproval: mutating },
      availability: {
        status: connector.status,
        ...(connector.lastTest?.ok ? { lastRefreshedAt: connector.lastTest.at.toISOString() } : {}),
      },
      flags: tool.flags,
      notice: UNTRUSTED_NOTICE,
    },
    next: [
      {
        tool: "studix_tool_execute",
        arguments: { tool: name, arguments: {} },
        reason: "Call it with arguments matching inputSchema.",
      },
    ],
    traceId: currentTraceId(),
  };
}
