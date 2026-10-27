import {
  type Attributes,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { redact, toStudixError } from "@studix/shared";
import { type SpanScope, sanitizeAttributes, scopeAttributes } from "./span-attributes.ts";

export const STUDIX_TRACER_NAME = "studix";

export interface StartSpanOptions {
  scope?: SpanScope;
  /** Extra attributes; sanitized (redacted) before they reach the span. */
  attributes?: Record<string, unknown>;
  kind?: SpanKind;
  /** Tracer to use; defaults to the global `studix` tracer (no-op until an SDK is registered). */
  tracer?: Tracer;
}

function spanAttributes(options: StartSpanOptions): Attributes {
  return { ...sanitizeAttributes(options.attributes), ...scopeAttributes(options.scope ?? {}) };
}

/** Global Studix tracer. Applications register an OTel SDK; libraries only depend on the API. */
export function getTracer(): Tracer {
  return trace.getTracer(STUDIX_TRACER_NAME);
}

/** Start a span (child of the active span) with redacted Studix attributes. Caller must call `end()`. */
export function startSpan(name: string, options: StartSpanOptions = {}): Span {
  const tracer = options.tracer ?? getTracer();
  return tracer.startSpan(name, {
    kind: options.kind ?? SpanKind.INTERNAL,
    attributes: spanAttributes(options),
  });
}

/** Set additional sanitized attributes (for example a model chosen mid-span). */
export function setSpanAttributes(span: Span, attributes: Record<string, unknown>, scope?: SpanScope): void {
  span.setAttributes({ ...sanitizeAttributes(attributes), ...scopeAttributes(scope ?? {}) });
}

/** Record a failure on a span without leaking secrets from the message or stack. */
export function recordSpanError(span: Span, error: unknown): void {
  const err = toStudixError(error);
  span.recordException({
    name: err.code,
    message: redact(err.message),
    ...(err.stack ? { stack: redact(err.stack) } : {}),
  });
  span.setAttribute("studix.error.code", err.code);
  span.setStatus({ code: SpanStatusCode.ERROR, message: redact(err.message) });
}

/**
 * Run `fn` inside a new active span. The span ends when `fn` settles; failures are recorded
 * (redacted) and rethrown unchanged so callers keep their own error handling.
 */
export async function withSpan<T>(
  name: string,
  options: StartSpanOptions,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const span = startSpan(name, options);
  try {
    const result = await context.with(trace.setSpan(context.active(), span), () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    recordSpanError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/** Trace identifiers of the active span, if any (used to correlate DB activity events with traces). */
export function activeTraceIds(): { traceId: string; spanId: string } | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return undefined;
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
