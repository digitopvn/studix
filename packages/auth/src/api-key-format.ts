import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Workspace API key wire format: `stx_<env>_<secret>`.
 * - `env` is a short tag from STUDIX_API_KEY_ENV (e.g. `dev`, `stg`, `live`) so a leaked key shows where it
 *   belongs without revealing anything secret.
 * - `secret` is 32 crypto-random bytes, base64url without padding (43 chars, 256 bits of entropy).
 * Only the SHA-256 hex digest and a short non-secret display prefix are ever stored.
 */
export const API_KEY_SCHEME = "stx";
const SECRET_BYTES = 32;
const ENV_PATTERN = /^[a-z0-9]{2,8}$/;
const KEY_PATTERN = /^stx_([a-z0-9]{2,8})_([A-Za-z0-9_-]{43})$/;
/** Characters of the secret kept in the display prefix (non-secret: ~36 bits, not enough to guess the rest). */
const DISPLAY_SECRET_CHARS = 6;

export interface GeneratedApiKey {
  /** Full key, shown to the user exactly once. */
  key: string;
  /** SHA-256 hex digest stored in `api_keys.hash`. */
  hash: string;
  /** Display hint such as `stx_dev_AbC123`, safe to store and show. */
  prefix: string;
}

export function assertApiKeyEnv(env: string): void {
  if (!ENV_PATTERN.test(env)) throw new RangeError("API key env must be 2-8 lowercase alphanumerics");
}

/** SHA-256 hex digest of a key. Keys carry 256 bits of entropy, so an unsalted fast hash is appropriate. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateApiKey(env: string): GeneratedApiKey {
  assertApiKeyEnv(env);
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const key = `${API_KEY_SCHEME}_${env}_${secret}`;
  return {
    key,
    hash: hashApiKey(key),
    prefix: `${API_KEY_SCHEME}_${env}_${secret.slice(0, DISPLAY_SECRET_CHARS)}`,
  };
}

/** True when the string has the exact shape of a Studix key (no I/O, no secret comparison). */
export function isApiKeyFormat(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header. Returns undefined for a missing or
 * malformed header. The scheme is matched case-insensitively per RFC 6750.
 */
export function parseBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = /^Bearer[ \t]+(\S+)\s*$/i.exec(value);
  return match?.[1];
}

/** Constant-time equality of two hex digests of equal length. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
