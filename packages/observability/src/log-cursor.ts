import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { StudixError } from "@studix/shared";

/** What a log cursor is bound to; a cursor replayed against anything else is refused. */
export interface LogCursorBinding {
  organizationId: string;
  workspaceId: string;
  environment: string;
  /** Hash of the filters that shape the result (see `filterDigest`). */
  filters: string;
}

export interface LogCursorPosition {
  /** Id of the last event handed out; the next page continues after (tail) or before (query) it. */
  after: string;
  /** The resolved query window, so later pages keep the first page's window. */
  from?: number;
  to?: number;
}

interface CursorPayload extends LogCursorBinding, LogCursorPosition {
  v: 1;
  /** Expiry, epoch milliseconds. */
  x: number;
}

export type CursorReadResult =
  | { ok: true; position: LogCursorPosition }
  | { ok: false; reason: "expired"; position: LogCursorPosition }
  | { ok: false; reason: "invalid" };

const KEY_CONTEXT = "studix.logs.cursor.v1";

function signature(secret: string, body: string): Buffer {
  return createHmac("sha256", `${KEY_CONTEXT}:${secret}`).update(body).digest();
}

/** Stable digest of a filter object: key order and undefined values do not matter. */
export function filterDigest(filters: Record<string, unknown>): string {
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("base64url").slice(0, 22);
}

/** An opaque, signed, expiring cursor: base64url(payload).base64url(hmac). */
export function signLogCursor(
  secret: string,
  binding: LogCursorBinding,
  position: LogCursorPosition,
  expiresAt: Date,
): string {
  const payload: CursorPayload = { v: 1, ...binding, ...position, x: expiresAt.getTime() };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signature(secret, body).toString("base64url")}`;
}

/**
 * Verify a cursor against the caller's binding. A bad signature, another tenant, another environment or
 * other filters are all `invalid` (indistinguishable, so a cursor reveals nothing); only a genuine cursor
 * past its expiry reports `expired`, together with its position so a tail can resume and flag the gap.
 */
export function readLogCursor(
  secret: string,
  cursor: string,
  binding: LogCursorBinding,
  now: Date,
): CursorReadResult {
  const [body, sig, extra] = cursor.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, reason: "invalid" };
  const given = Buffer.from(sig, "base64url");
  const expected = signature(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "invalid" };
  }
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (
    payload.v !== 1 ||
    typeof payload.after !== "string" ||
    payload.organizationId !== binding.organizationId ||
    payload.workspaceId !== binding.workspaceId ||
    payload.environment !== binding.environment ||
    payload.filters !== binding.filters
  ) {
    return { ok: false, reason: "invalid" };
  }
  const position: LogCursorPosition = {
    after: payload.after,
    ...(typeof payload.from === "number" ? { from: payload.from } : {}),
    ...(typeof payload.to === "number" ? { to: payload.to } : {}),
  };
  if (payload.x <= now.getTime()) return { ok: false, reason: "expired", position };
  return { ok: true, position };
}

export function invalidCursorError(): StudixError {
  return new StudixError("VALIDATION", "The cursor is not valid for this request", {
    suggestedAction: "Repeat the request without a cursor, or pass the nextCursor of the same request.",
  });
}
