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

/** Suggested action for an INTERNAL error that a Studix defect, not the caller's input, caused. */
export const STUDIX_DEFECT_ACTION =
  "This is a Studix defect, not a problem with your request; retrying the same request fails the same way. Report the job id to the Studix team.";

/** Extra hint when a size or count limit tripped: a smaller request may stay under it until the fix lands. */
const SIZE_LIMIT_HINT = " Until it is fixed, a shorter or simpler brief may stay under the limit.";

/** At most this many schema issues are kept in `details.issues`, so the payload stays small. */
const MAX_SCHEMA_ISSUES = 5;
const MAX_ISSUE_MESSAGE = 200;

/** One compact schema issue: JSON pointer, zod issue code and its one-line message. */
export interface SchemaIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * Read the issues of a zod error without importing zod's class, so a second zod copy still matches.
 * Returns undefined for anything that is not a zod error.
 */
function schemaIssuesOf(err: Error): SchemaIssue[] | undefined {
  if (err.name !== "ZodError" && err.name !== "$ZodError") return undefined;
  const raw: unknown = (err as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) return undefined;
  return raw.map((issue: { path?: unknown; code?: unknown; message?: unknown }) => {
    const path = Array.isArray(issue.path) ? issue.path : [];
    const message = String(issue.message ?? "invalid value").replace(/\s+/g, " ");
    return {
      path:
        path.length === 0
          ? "(root)"
          : `/${path.map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`,
      code: String(issue.code ?? "invalid"),
      message: message.length > MAX_ISSUE_MESSAGE ? `${message.slice(0, MAX_ISSUE_MESSAGE - 1)}…` : message,
    };
  });
}

/**
 * A one-line error for a failed schema check, instead of zod's multi-line JSON dump: the first issue's
 * path and constraint in the message, the first few issues in `details.issues`. An INTERNAL one tells
 * the caller it is a Studix defect, and hints at a smaller brief when a size limit tripped.
 */
export function schemaFailure(
  code: ErrorCode,
  what: string,
  issues: readonly SchemaIssue[],
  cause?: unknown,
): StudixError {
  const [first] = issues;
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  const message = first ? `${what} at ${first.path || "(root)"}: ${first.message}${more}` : what;
  const sizeLimit = issues.some((i) => i.code === "too_big" || i.code === "too_small");
  return new StudixError(code, message, {
    cause,
    details: { kind: "schema", issueCount: issues.length, issues: issues.slice(0, MAX_SCHEMA_ISSUES) },
    ...(code === "INTERNAL"
      ? { suggestedAction: STUDIX_DEFECT_ACTION + (sizeLimit ? SIZE_LIMIT_HINT : ""), retryable: false }
      : {}),
  });
}

/**
 * Wrap anything thrown into a StudixError; existing StudixErrors pass through unchanged. A zod error
 * becomes a one-line message plus compact `details.issues`, never the raw multi-line dump.
 */
export function toStudixError(err: unknown, fallback: ErrorCode = "INTERNAL"): StudixError {
  if (err instanceof StudixError) return err;
  if (err instanceof Error) {
    if (err.name === "AbortError") return new StudixError("CANCELLED", err.message, { cause: err });
    if (err.name === "TimeoutError") return new StudixError("TIMEOUT", err.message, { cause: err });
    const issues = schemaIssuesOf(err);
    if (issues) return schemaFailure(fallback, "Schema check failed", issues, err);
    return new StudixError(fallback, err.message, { cause: err });
  }
  return new StudixError(fallback, typeof err === "string" ? err : "Unknown error", {
    details: err === undefined ? undefined : { thrown: String(err) },
  });
}
