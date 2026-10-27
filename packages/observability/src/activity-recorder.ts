import type { ActivityEvent, ActivityLevel, ActivityRepository, TenantContext } from "@studix/core";
import { type Logger, redact, redactDeep } from "@studix/shared";
import type { SpanScope } from "./span-attributes.ts";
import { activeTraceIds } from "./tracing.ts";

export interface ActivityInput {
  name: string;
  level?: ActivityLevel;
  message?: string;
  scope?: Omit<SpanScope, "organizationId" | "workspaceId">;
  durationMs?: number;
  attributes?: Record<string, unknown>;
  /** Explicit trace correlation; defaults to the active span. */
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

/**
 * Writes user-visible activity/trace events (dashboard timeline, job traces) to the database.
 * Recording is best effort: a storage failure is logged and reported as `undefined`, never thrown,
 * so telemetry cannot fail the work it describes.
 */
export interface ActivityRecorder {
  record(ctx: TenantContext, input: ActivityInput): Promise<ActivityEvent | undefined>;
}

export interface ActivityRecorderOptions {
  logger: Logger;
}

export function createActivityRecorder(
  repository: ActivityRepository,
  options: ActivityRecorderOptions,
): ActivityRecorder {
  return {
    async record(ctx, input) {
      const active = activeTraceIds();
      const traceId = input.traceId ?? active?.traceId;
      const spanId = input.spanId ?? (input.traceId ? undefined : active?.spanId);
      const scope = input.scope ?? {};
      try {
        return await repository.append(ctx, {
          name: input.name,
          level: input.level ?? "info",
          ...(input.message !== undefined ? { message: redact(input.message) } : {}),
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
          ...(scope.jobId ? { jobId: scope.jobId } : {}),
          ...(scope.stage ? { stage: scope.stage } : {}),
          ...(scope.provider ? { provider: scope.provider } : {}),
          ...(scope.model ? { model: scope.model } : {}),
          ...(traceId ? { traceId } : {}),
          ...(spanId ? { spanId } : {}),
          ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
          ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
          attributes: redactDeep(input.attributes ?? {}),
        });
      } catch (error) {
        options.logger.warn("activity event not recorded", {
          event: input.name,
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    },
  };
}
