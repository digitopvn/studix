import { assertTenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { DecisionRequest, JsonSchema } from "./decision-types.ts";

/** Decision kinds: lowercase dot-separated segments, e.g. `video.plan`, `qa.route_issue`. */
const KIND_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;
/** Upper bound for a single decision call; longer work belongs in a durable job stage. */
export const MAX_DECISION_TIMEOUT_MS = 10 * 60_000;

function invalid(message: string, field: string): StudixError {
  return new StudixError("VALIDATION", `Invalid decision request: ${message}`, {
    details: { field },
    suggestedAction: "Fix the decision request; this is a caller bug, not a provider failure.",
  });
}

/** Validate a decision request at the decision-layer boundary. Throws VALIDATION (non-retryable). */
export function validateDecisionRequest(request: DecisionRequest<unknown>): void {
  if (!request || typeof request !== "object") throw invalid("request must be an object", "request");
  if (typeof request.kind !== "string" || !KIND_PATTERN.test(request.kind)) {
    throw invalid("kind must be lowercase dot-separated segments", "kind");
  }
  assertTenantContext(request.tenant);
  if (!(request.schema instanceof z.ZodType)) throw invalid("schema must be a zod schema", "schema");
  if (!Number.isFinite(request.budgetCents) || request.budgetCents < 0) {
    throw invalid("budgetCents must be a finite number >= 0", "budgetCents");
  }
  if (
    !Number.isFinite(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > MAX_DECISION_TIMEOUT_MS
  ) {
    throw invalid(`timeoutMs must be in (0, ${MAX_DECISION_TIMEOUT_MS}]`, "timeoutMs");
  }
  if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.trim() === "") {
    throw invalid("idempotencyKey is required", "idempotencyKey");
  }
  if (request.idempotencyKey.length > 200) throw invalid("idempotencyKey is too long", "idempotencyKey");
}

const jsonSchemaCache = new WeakMap<z.ZodType, JsonSchema>();

/** JSON Schema for the request output: the caller's, else derived from the zod schema (cached). */
export function resolveJsonSchema(request: DecisionRequest<unknown>): JsonSchema {
  if (request.jsonSchema) return request.jsonSchema;
  const cached = jsonSchemaCache.get(request.schema);
  if (cached) return cached;
  let derived: JsonSchema;
  try {
    derived = z.toJSONSchema(request.schema, { target: "draft-2020-12", io: "output" }) as JsonSchema;
  } catch (error) {
    throw new StudixError("VALIDATION", "Decision schema cannot be expressed as JSON Schema", {
      cause: error,
      suggestedAction: "Pass `jsonSchema` explicitly or avoid transforms/custom types in the schema.",
    });
  }
  jsonSchemaCache.set(request.schema, derived);
  return derived;
}
