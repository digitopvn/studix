import { type ErrorCode, type Logger, redactDeep, StudixError, toStudixError } from "@studix/shared";
import type { NextFunction, Request, Response } from "express";

export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CANCELLED: 409,
  APPROVAL_REQUIRED: 409,
  BUDGET_EXCEEDED: 402,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  PROVIDER_ERROR: 502,
  PROVIDER_OVERLOADED: 503,
  UNAVAILABLE: 503,
  TIMEOUT: 504,
};

/** Body-parser failures carry a `type`; map them to VALIDATION with the right HTTP status. */
function fromBodyParser(err: unknown): { error: StudixError; status: number } | undefined {
  const type = typeof err === "object" && err !== null ? (err as { type?: unknown }).type : undefined;
  if (type === "entity.too.large") {
    return { error: new StudixError("VALIDATION", "Request body too large"), status: 413 };
  }
  if (type === "entity.parse.failed") {
    return { error: new StudixError("VALIDATION", "Malformed JSON body"), status: 400 };
  }
  return undefined;
}

/** Client-safe JSON error payload. INTERNAL errors never expose their message. */
export function publicError(error: StudixError) {
  const payload = error.toJSON();
  if (error.code === "INTERNAL") {
    return { code: payload.code, message: "Internal error", retryable: payload.retryable };
  }
  return payload.details ? { ...payload, details: redactDeep(payload.details) } : payload;
}

/** Terminal JSON error handler for /api routes. */
export function apiErrorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const parsed = fromBodyParser(err);
    const error = parsed?.error ?? toStudixError(err);
    const status = parsed?.status ?? HTTP_STATUS[error.code] ?? 500;
    if (status >= 500) {
      logger.error("api request failed", {
        method: req.method,
        path: req.path,
        code: error.code,
        error: error.message,
      });
    }
    if (res.headersSent) return;
    res.status(status).json({ error: publicError(error) });
  };
}
