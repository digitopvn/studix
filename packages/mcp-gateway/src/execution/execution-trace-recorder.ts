import { type AuditRepository, actorRef } from "@studix/core";
import type { ActivityRecorder } from "@studix/observability";
import { type ErrorCode, type Logger, redactDeep } from "@studix/shared";
import type { GatewayCallContext } from "./gateway-call-context.ts";

export type ExecutionOutcome = "succeeded" | "tool_error" | "failed" | "denied";

/**
 * One downstream execution as recorded in audit, activity and logs. Holds ids, verdicts and sizes only:
 * no arguments, no result content, no credentials or secret references.
 */
export interface ExecutionRecord {
  traceId: string;
  qualifiedTool: string;
  connectorId?: string;
  connectorName?: string;
  verdict: string;
  outcome: ExecutionOutcome;
  latencyMs: number;
  attempts: number;
  mutating?: boolean;
  approvalId?: string;
  resultBytes?: number;
  originalBytes?: number;
  truncated?: boolean;
  errorCode?: ErrorCode;
}

export interface ExecutionTraceDeps {
  audit: AuditRepository;
  activity?: ActivityRecorder;
  logger: Logger;
}

/** Persist the audit + activity trail for an execution. Best effort: telemetry never fails the call. */
export async function recordExecution(
  deps: ExecutionTraceDeps,
  call: GatewayCallContext,
  record: ExecutionRecord,
): Promise<void> {
  const ctx = call.tenant;
  const data = redactDeep({
    ...record,
    ...(call.jobId ? { jobId: call.jobId } : {}),
    ...(call.projectId ? { projectId: call.projectId } : {}),
  }) as unknown as Record<string, unknown>;
  const level = record.outcome === "succeeded" ? "info" : record.outcome === "denied" ? "warn" : "error";

  const writes: Array<Promise<unknown>> = [
    deps.audit
      .append(ctx, {
        actor: actorRef(ctx.actor),
        action: record.outcome === "denied" ? "connector.tool.denied" : "connector.tool.executed",
        subjectType: "connector_tool",
        subjectId: record.qualifiedTool,
        data,
      })
      .catch((error: unknown) => {
        deps.logger.warn("connector execution audit not recorded", {
          workspaceId: ctx.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
  ];
  if (deps.activity) {
    writes.push(
      deps.activity.record(ctx, {
        name: "mcp_gateway.tool.execute",
        level,
        message: `${record.qualifiedTool} ${record.outcome}`,
        traceId: record.traceId,
        durationMs: record.latencyMs,
        scope: {
          ...(call.jobId ? { jobId: call.jobId } : {}),
          ...(call.projectId ? { projectId: call.projectId } : {}),
          ...(record.connectorName ? { provider: `mcp:${record.connectorName}` } : {}),
        },
        attributes: data,
      }),
    );
  }
  await Promise.all(writes);
  deps.logger[level]("mcp_gateway.tool.execute", {
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId,
    ...data,
  });
}
