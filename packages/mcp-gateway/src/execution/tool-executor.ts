import { performance } from "node:perf_hooks";
import { scopeFromTenant, setSpanAttributes, withSpan } from "@studix/observability";
import { redact, redactDeep, StudixError, toStudixError } from "@studix/shared";
import { z } from "zod";
import { byteLength, qualifyToolName } from "../catalog/tool-normalizer.ts";
import { MAX_GATEWAY_DEPTH } from "../client/gateway-depth.ts";
import {
  DownstreamError,
  type DownstreamTarget,
  type RawDownstreamResult,
} from "../client/mcp-client-adapter.ts";
import { parseInput } from "../discovery/tool-discovery-service.ts";
import {
  authorizeCall,
  currentTraceId,
  downstreamTarget,
  type GatewayRuntime,
  loadConnectorTool,
} from "../gateway-runtime.ts";
import {
  evaluateToolPermission,
  GATEWAY_PERMISSIONS,
  isMutatingTool,
} from "../policy/tool-permission-policy.ts";
import { type ExecutionRecord, recordExecution } from "./execution-trace-recorder.ts";
import type { GatewayCallContext, GatewayResult } from "./gateway-call-context.ts";
import { enforceMutationApproval } from "./mutation-approval-gate.ts";
import { capToolResult, type UntrustedToolOutput } from "./tool-result-capper.ts";

export const ToolExecuteInput = z.object({
  tool: z.string().min(3).max(200).describe("Qualified tool name `connector.tool`."),
  arguments: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Arguments matching the tool's inputSchema."),
});
export type ToolExecuteInput = z.input<typeof ToolExecuteInput>;

export interface ToolExecuteData {
  tool: string;
  connector: string;
  outcome: "succeeded" | "tool_error";
  mutating: boolean;
  attempts: number;
  latencyMs: number;
  approvalId?: string;
  result: UntrustedToolOutput;
}

/**
 * Call downstream with a per-attempt deadline. Only failures that provably never reached the tool
 * (connect phase) or read-only tools are retried, once; mutating calls with an unknown outcome never are.
 */
async function callWithRetry(
  rt: GatewayRuntime,
  target: DownstreamTarget,
  toolName: string,
  args: Record<string, unknown>,
  mutating: boolean,
): Promise<{ raw: RawDownstreamResult; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const raw = await rt.client.callTool(target, toolName, args, {
        signal: AbortSignal.timeout(rt.limits.timeoutMs),
        timeoutMs: rt.limits.timeoutMs,
      });
      return { raw, attempts: attempt };
    } catch (error) {
      const safeToRetry =
        error instanceof DownstreamError &&
        error.code === "UNAVAILABLE" &&
        (error.phase === "connect" || !mutating);
      if (attempt >= 2 || !safeToRetry) {
        if (mutating && error instanceof DownstreamError && error.phase === "call") {
          throw new StudixError(error.code, error.message, {
            retryable: false,
            suggestedAction: "The outcome is unknown. Check the connector's state before trying again.",
            details: { outcomeUnknown: true },
          });
        }
        // Drop adapter internals (phase/cause) from what the caller sees.
        throw error instanceof DownstreamError
          ? new StudixError(error.code, error.message, { retryable: error.retryable })
          : error;
      }
    }
  }
}

/** `studix_tool_execute`: re-authorize from current state, enforce caps, call downstream, trace and audit. */
export async function executeTool(
  rt: GatewayRuntime,
  call: GatewayCallContext,
  input: ToolExecuteInput,
): Promise<GatewayResult<ToolExecuteData>> {
  authorizeCall(call, GATEWAY_PERMISSIONS.execute);
  const parsed = parseInput(ToolExecuteInput, input);
  const scope = scopeFromTenant(call.tenant, {
    ...(call.jobId ? { jobId: call.jobId } : {}),
    ...(call.projectId ? { projectId: call.projectId } : {}),
  });

  return withSpan(
    "mcp_gateway.tool.execute",
    { scope, attributes: { "studix.mcp.tool": parsed.tool } },
    async (span) => {
      const traceId = currentTraceId();
      const started = performance.now();
      const record: ExecutionRecord = {
        traceId,
        qualifiedTool: parsed.tool,
        verdict: "unchecked",
        outcome: "denied",
        latencyMs: 0,
        attempts: 0,
      };
      try {
        if ((call.depth ?? 0) > MAX_GATEWAY_DEPTH) {
          record.verdict = "recursion-refused";
          throw new StudixError("FORBIDDEN", "Nested gateway execution is not allowed", { retryable: false });
        }
        if (byteLength(parsed.arguments) > rt.limits.maxArgumentBytes) {
          record.verdict = "arguments-too-large";
          throw new StudixError("VALIDATION", `arguments exceed ${rt.limits.maxArgumentBytes} bytes`);
        }
        // Re-authorize from current Postgres state: an earlier search/inspect grants nothing.
        const { connector, tool } = await loadConnectorTool(rt, call, parsed.tool);
        record.connectorId = connector.id;
        record.connectorName = connector.name;
        const verdict = evaluateToolPermission(connector, tool.name);
        record.verdict = verdict.reason;
        if (!verdict.allowed) {
          throw new StudixError("FORBIDDEN", `Tool ${parsed.tool} is not available (${verdict.reason})`, {
            retryable: false,
            suggestedAction: "Ask a workspace admin to enable the connector or grant this tool.",
          });
        }
        await rt.budget.reserve(call, parsed.tool);
        const mutating = isMutatingTool(tool);
        record.mutating = mutating;
        const approvalId = mutating
          ? await enforceMutationApproval(
              { approvals: rt.approvals, audit: rt.audit, policy: rt.approvalPolicy, clock: rt.clock },
              call,
              parsed.tool,
              parsed.arguments,
            )
          : undefined;
        if (approvalId) record.approvalId = approvalId;

        const release = rt.concurrency.acquire(call.tenant.workspaceId);
        let raw: RawDownstreamResult;
        try {
          record.outcome = "failed";
          const target = await downstreamTarget(rt, call, connector);
          const result = await callWithRetry(rt, target, tool.name, parsed.arguments, mutating);
          raw = result.raw;
          record.attempts = result.attempts;
        } finally {
          release();
        }

        const output = await capToolResult(raw, {
          ctx: call.tenant,
          connectorName: connector.name,
          qualifiedTool: parsed.tool,
          ...(call.jobId ? { jobId: call.jobId } : {}),
          maxResultBytes: rt.limits.maxResultBytes,
          ...(rt.resultStore ? { store: rt.resultStore } : {}),
        });
        record.outcome = output.isError ? "tool_error" : "succeeded";
        record.resultBytes = output.resultBytes;
        record.originalBytes = output.originalBytes;
        record.truncated = output.truncated;
        record.latencyMs = Math.round(performance.now() - started);
        setSpanAttributes(span, {
          "studix.mcp.connector": connector.name,
          "studix.mcp.verdict": record.verdict,
          "studix.mcp.outcome": record.outcome,
          "studix.mcp.result_bytes": output.resultBytes,
          "studix.mcp.truncated": output.truncated,
        });
        return {
          data: {
            tool: qualifyToolName(connector.name, tool.name),
            connector: connector.name,
            outcome: record.outcome === "tool_error" ? "tool_error" : "succeeded",
            mutating,
            attempts: record.attempts,
            latencyMs: record.latencyMs,
            ...(approvalId ? { approvalId } : {}),
            result: output,
          },
          next: [],
          traceId,
        };
      } catch (error) {
        const err = toStudixError(error);
        record.errorCode = err.code;
        record.latencyMs = Math.round(performance.now() - started);
        setSpanAttributes(span, {
          "studix.mcp.verdict": record.verdict,
          "studix.mcp.outcome": record.outcome,
        });
        // Downstream error text is untrusted and may echo the outbound credential: always redact.
        throw new StudixError(err.code, redact(err.message).slice(0, 500), {
          retryable: err.retryable,
          ...(err.suggestedAction ? { suggestedAction: err.suggestedAction } : {}),
          details: redactDeep({ ...(err.details ?? {}), traceId }),
        });
      } finally {
        await recordExecution({ audit: rt.audit, activity: rt.activity, logger: rt.logger }, call, record);
      }
    },
  );
}
