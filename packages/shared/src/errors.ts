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

/** Issues kept on a schema failure: enough to locate the defect without flooding an agent's context. */
const MAX_SCHEMA_ISSUES = 5;

interface SchemaIssue {
  path: string;
  code?: string;
  message: string;
}

/** A thrown zod error, matched by shape so a second zod copy in the bundle is still recognised. */
function schemaIssues(err: Error): SchemaIssue[] | undefined {
  const issues = (err as { issues?: unknown }).issues;
  if (!/^\$?ZodError$/.test(err.name) || !Array.isArray(issues) || issues.length === 0) return undefined;
  return issues.map((raw) => {
    const issue = (raw ?? {}) as { path?: unknown; code?: unknown; message?: unknown };
    const path = Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";
    return {
      path: path || "(root)",
      ...(typeof issue.code === "string" ? { code: issue.code } : {}),
      message: typeof issue.message === "string" ? issue.message : "invalid value",
    };
  });
}

/**
 * A schema rejected data Studix handled (e.g. a stage built an invalid IR). Report it as one line with the
 * failing path, never as the multi-line zod dump. Only an INTERNAL failure is named a Studix defect; a caller
 * that classifies it otherwise (e.g. PROVIDER_ERROR) keeps its code's own retry policy and wording.
 */
function schemaFailure(err: Error, issues: SchemaIssue[], fallback: ErrorCode): StudixError {
  const [first] = issues as [SchemaIssue, ...SchemaIssue[]];
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  const where = `invalid data at ${first.path}: ${first.message}${more}`;
  const details = { issues: issues.slice(0, MAX_SCHEMA_ISSUES), issueCount: issues.length };
  if (fallback !== "INTERNAL") return new StudixError(fallback, `Received ${where}`, { details, cause: err });
  return new StudixError("INTERNAL", `Studix produced ${where}`, {
    retryable: false,
    suggestedAction:
      "This is a Studix defect, not a mistake in your request; retrying it unchanged fails the same way. Report it to Studix with the job or trace id. If a long brief led to it, a shorter one may avoid the limit meanwhile.",
    details,
    cause: err,
  });
}

/** Wrap anything thrown into a StudixError; existing StudixErrors pass through unchanged. */
export function toStudixError(err: unknown, fallback: ErrorCode = "INTERNAL"): StudixError {
  if (err instanceof StudixError) return err;
  if (err instanceof Error) {
    const issues = schemaIssues(err);
    if (issues) return schemaFailure(err, issues, fallback);
    if (err.name === "AbortError") return new StudixError("CANCELLED", err.message, { cause: err });
    if (err.name === "TimeoutError") return new StudixError("TIMEOUT", err.message, { cause: err });
    return new StudixError(fallback, err.message, { cause: err });
  }
  return new StudixError(fallback, typeof err === "string" ? err : "Unknown error", {
    details: err === undefined ? undefined : { thrown: String(err) },
  });
}
