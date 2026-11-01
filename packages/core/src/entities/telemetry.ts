import type { StudixErrorPayload } from "@studix/shared";
import type { ActorRef, TenantOwned } from "./common.ts";

export const PROVIDER_EXECUTION_STATUSES = ["succeeded", "failed", "cancelled", "timeout"] as const;
export type ProviderExecutionStatus = (typeof PROVIDER_EXECUTION_STATUSES)[number];

/**
 * Who paid the provider for a call: the operator's own keys, a workspace's provider connection, a member's
 * personal connection, or the MCP client's own agent (host mode). Spend on a workspace's or member's own key
 * (BYOK) is recorded but never charged to the workspace (ADR 0016); job budget caps still count it.
 */
export const FUNDING_SOURCES = ["operator", "workspace", "member", "host"] as const;
export type FundingSource = (typeof FUNDING_SOURCES)[number];

/** The funding of spend on a stored provider connection, from the connection's owner. */
export function connectionFunding(owner: "workspace" | "user"): FundingSource {
  return owner === "user" ? "member" : "workspace";
}

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
  /** Who paid for the call; `operator` when omitted. */
  funding?: FundingSource;
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
  /** Who paid for this spend; `operator` when omitted. */
  funding?: FundingSource;
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
