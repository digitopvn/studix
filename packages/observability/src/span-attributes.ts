import type { Attributes, AttributeValue } from "@opentelemetry/api";
import type { TenantContext } from "@studix/core";
import { isSecretKey, REDACTED, redact } from "@studix/shared";

/** Studix correlation dimensions attached to every span and activity event. */
export interface SpanScope {
  organizationId?: string;
  workspaceId?: string;
  projectId?: string;
  jobId?: string;
  stage?: string;
  provider?: string;
  model?: string;
}

/** Stable attribute names (namespaced so they never collide with OTel semantic conventions). */
export const STUDIX_ATTRIBUTES = {
  organizationId: "studix.organization.id",
  workspaceId: "studix.workspace.id",
  projectId: "studix.project.id",
  jobId: "studix.job.id",
  stage: "studix.stage",
  provider: "studix.provider",
  model: "studix.model",
} as const satisfies Record<keyof SpanScope, string>;

/** Longest string kept in an attribute; longer values are truncated to keep exporters cheap. */
export const MAX_ATTRIBUTE_LENGTH = 2048;

/** Scope for work performed on behalf of a tenant. */
export function scopeFromTenant(
  ctx: TenantContext,
  extra: Omit<SpanScope, "organizationId" | "workspaceId"> = {},
): SpanScope {
  return { organizationId: ctx.organizationId, workspaceId: ctx.workspaceId, ...extra };
}

/** Convert a scope into `studix.*` span attributes, skipping unset dimensions. */
export function scopeAttributes(scope: SpanScope): Attributes {
  const out: Attributes = {};
  for (const [field, name] of Object.entries(STUDIX_ATTRIBUTES) as [keyof SpanScope, string][]) {
    const value = scope[field];
    if (value !== undefined && value !== "") out[name] = sanitizeString(value);
  }
  return out;
}

function sanitizeString(value: string): string {
  const scrubbed = redact(value);
  return scrubbed.length > MAX_ATTRIBUTE_LENGTH ? `${scrubbed.slice(0, MAX_ATTRIBUTE_LENGTH)}…` : scrubbed;
}

function sanitizeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    // OTel arrays must be homogeneous primitives; anything else is serialized as redacted JSON.
    if (value.every((item) => typeof item === "string")) return value.map(sanitizeString);
    if (value.every((item) => typeof item === "number")) return value as number[];
    if (value.every((item) => typeof item === "boolean")) return value as boolean[];
  }
  if (value === undefined || value === null || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  try {
    return sanitizeString(
      JSON.stringify(value, (key, inner: unknown) => (key && isSecretKey(key) ? REDACTED : inner)),
    );
  } catch {
    return "[unserializable]";
  }
}

/**
 * Turn arbitrary attributes into OTel-safe, secret-free attributes: secret-named keys are replaced,
 * strings are pattern-redacted and truncated, nested objects become redacted JSON, nullish values are dropped.
 */
export function sanitizeAttributes(attributes: Record<string, unknown> | undefined): Attributes {
  const out: Attributes = {};
  if (!attributes) return out;
  for (const [key, value] of Object.entries(attributes)) {
    if (isSecretKey(key)) {
      if (value !== undefined && value !== null) out[key] = REDACTED;
      continue;
    }
    const sanitized = sanitizeValue(value);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}
