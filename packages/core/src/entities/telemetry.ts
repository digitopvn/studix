import type { StudixErrorPayload } from "@studix/shared";
import type { ActorRef, TenantOwned } from "./common.ts";

export const PROVIDER_EXECUTION_STATUSES = ["succeeded", "failed", "cancelled", "timeout"] as const;
export type ProviderExecutionStatus = (typeof PROVIDER_EXECUTION_STATUSES)[number];

/** One call to an external provider (model, media API, downstream MCP tool). */
export interface ProviderExecution extends TenantOwned {
  jobId?: string;
  stageId?: string;
  provider: string;
  model?: string;
  operation: string;
  status: ProviderExecutionStatus;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Fractional cents are allowed (token pricing). */
  costCents: number;
  attempt: number;
  error?: StudixErrorPayload;
}

/**
 * Billable usage line. `dedupeKey` is unique per workspace so retries never double-charge
 * (e.g. `${jobId}:${stage}:${attempt}:render`).
 */
export interface UsageEvent extends TenantOwned {
  dedupeKey: string;
  kind: string;
  quantity: number;
  unit: string;
  costCents: number;
  jobId?: string;
  providerExecutionId?: string;
  metadata?: Record<string, unknown>;
}

/** Immutable security/compliance record of who did what. */
export interface AuditEvent extends TenantOwned {
  actor: ActorRef;
  action: string;
  subjectType: string;
  subjectId?: string;
  data?: Record<string, unknown>;
}

export const ACTIVITY_LEVELS = ["debug", "info", "warn", "error"] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

/** User-visible activity/trace event (dashboard timeline, job traces). Attributes are redacted. */
export interface ActivityEvent extends TenantOwned {
  name: string;
  level: ActivityLevel;
  message?: string;
  projectId?: string;
  jobId?: string;
  stage?: string;
  provider?: string;
  model?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
  attributes: Record<string, unknown>;
}
