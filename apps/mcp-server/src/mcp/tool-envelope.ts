import type { NextAction } from "@studix/core";
import { ERROR_CODES, redactDeep, type StudixError } from "@studix/shared";
import { z } from "zod";
import { publicError } from "../http/http-errors.ts";

/**
 * The single output envelope every Studix tool returns as structured content (docs/MCP_API.md):
 * `{status, data, next[], error?, traceId}`. `next` is always present; `error` only on failure.
 */
export const NextActionSchema = z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  reason: z.string(),
  pollAfterMs: z.number().optional(),
});

export const ToolErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  suggestedAction: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ToolEnvelopeSchema = z.object({
  status: z.enum(["ok", "error"]),
  data: z.record(z.string(), z.unknown()).nullable(),
  next: z.array(NextActionSchema),
  error: ToolErrorSchema.optional(),
  traceId: z.string(),
});
export type ToolEnvelope = z.infer<typeof ToolEnvelopeSchema>;

/** Dates become ISO strings and undefined fields disappear, as on the wire. */
export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

function toCallToolResult(envelope: ToolEnvelope, isError: boolean) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

export function okEnvelope(data: object, next: NextAction[], traceId: string) {
  return toCallToolResult(
    {
      status: "ok",
      data: toJsonSafe(data) as Record<string, unknown>,
      next: toJsonSafe(next) as ToolEnvelope["next"],
      traceId,
    },
    false,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An error may carry a `details.next` hint `{tool, arguments}`; surface it in `next`. */
function nextFromError(error: StudixError): NextAction[] {
  const hint = error.details?.next;
  if (!isRecord(hint) || typeof hint.tool !== "string") return [];
  return [
    {
      tool: hint.tool,
      arguments: isRecord(hint.arguments) ? hint.arguments : {},
      reason: error.suggestedAction ?? "Suggested follow-up for this error.",
    },
  ];
}

export function errorEnvelope(error: StudixError, traceId: string) {
  const payload = publicError(error);
  return toCallToolResult(
    {
      status: "error",
      data: null,
      next: toJsonSafe(redactDeep(nextFromError(error))) as ToolEnvelope["next"],
      error: toJsonSafe(payload) as ToolEnvelope["error"],
      traceId,
    },
    true,
  );
}
