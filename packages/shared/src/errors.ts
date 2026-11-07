/**
 * Normalized error model shared by every package so MCP responses, API responses, job records and
 * traces carry the same `{code, message, retryable, suggestedAction, details}` shape.
 */

export const ERROR_CODES = [
  "VALIDATION",
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CONFLICT",
  "BUDGET_EXCEEDED",
  "TIMEOUT",
  "CANCELLED",
  "RATE_LIMITED",
  "PROVIDER_OVERLOADED",
  "PROVIDER_ERROR",
  "UNAVAILABLE",
  "APPROVAL_REQUIRED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Codes that are worth retrying unless the caller states otherwise. */
const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set([
  "TIMEOUT",
  "RATE_LIMITED",
  "PROVIDER_OVERLOADED",
  "PROVIDER_ERROR",
  "UNAVAILABLE",
]);

/** JSON-safe representation of a StudixError (what clients and job records see). */
export interface StudixErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  suggestedAction?: string;
  details?: Record<string, unknown>;
}

export interface StudixErrorOptions {
  retryable?: boolean;
  suggestedAction?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class StudixError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly suggestedAction?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: StudixErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StudixError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.suggestedAction = options.suggestedAction;
    this.details = options.details;
  }

  toJSON(): StudixErrorPayload {
    const payload: StudixErrorPayload = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.suggestedAction !== undefined) payload.suggestedAction = this.suggestedAction;
    if (this.details !== undefined) payload.details = this.details;
    return payload;
  }

  /** Rebuild an error from its stored payload (e.g. a failed job record). */
  static fromJSON(payload: StudixErrorPayload): StudixError {
    return new StudixError(payload.code, payload.message, {
      retryable: payload.retryable,
      suggestedAction: payload.suggestedAction,
      details: payload.details,
    });
  }
}

export function isStudixError(err: unknown): err is StudixError {
  return err instanceof StudixError;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** Wrap anything thrown into a StudixError; existing StudixErrors pass through unchanged. */
export function toStudixError(err: unknown, fallback: ErrorCode = "INTERNAL"): StudixError {
  if (err instanceof StudixError) return err;
  if (err instanceof Error) {
    if (err.name === "AbortError") return new StudixError("CANCELLED", err.message, { cause: err });
    if (err.name === "TimeoutError") return new StudixError("TIMEOUT", err.message, { cause: err });
    return new StudixError(fallback, err.message, { cause: err });
  }
  return new StudixError(fallback, typeof err === "string" ? err : "Unknown error", {
    details: err === undefined ? undefined : { thrown: String(err) },
  });
}
