/**
 * Secret redaction for logs, traces, error details and anything that may reach a model prompt.
 * Pattern-based (well-known credential shapes) plus value-based: callers register known secret values
 * (for example provider keys loaded from the environment) so they are scrubbed verbatim.
 */

export const REDACTED = "[redacted]";

const PATTERNS: RegExp[] = [
  // Authorization headers
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Studix API keys: stx_<env>_<random>
  /\bstx_[a-z0-9]+_[A-Za-z0-9_-]{16,}/g,
  // Common provider key shapes
  /\bsk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // JWT
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Signed URL query parameters (S3/R2 presigned URLs, generic tokens)
  /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|signature|sig|token|access_token|api_key|apikey|key)=)[^&\s"']+/gi,
  // Passwords in connection strings (postgres://user:pass@host)
  /(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s"']+:)[^@\s"']+(?=@)/gi,
];

const KEY_VALUE =
  /(["']?(?:api[_-]?key|secret|password|passwd|token|access[_-]?token|authorization|cookie|set-cookie|x-api-key|client[_-]?secret)["']?\s*[:=]\s*)(["']?)[^"'\s,}]+\2/gi;

/** Object keys whose string values are always replaced wholesale. */
const SECRET_FIELD =
  /^(api[_-]?key|apikey|secret|.*[_-]secret|password|passwd|token|.*[_-]token|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|x-api-key|client[_-]?secret|private[_-]?key|.*Secret|.*Token|.*Password|.*ApiKey)$/i;

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;

/** Environment variable names whose values are treated as secrets. */
const SECRET_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|DATABASE_URL)/i;

const knownSecrets = new Set<string>();

/** Register literal secret values (min length 8) so they are always scrubbed. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

/** Register every environment variable whose name looks secret. */
export function registerSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_NAME.test(name)) registerSecret(value);
  }
}

/** Forget registered secret values (tests only). */
export function clearRegisteredSecrets(): void {
  knownSecrets.clear();
}

/** Redact secrets inside a free-form string. */
export function redact(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const re of PATTERNS) {
    out = out.replace(re, (match: string, prefix?: unknown) => {
      if (typeof prefix === "string" && /[?&]|:\/\//.test(prefix)) return `${prefix}${REDACTED}`;
      if (/^(Bearer|Basic)\s/i.test(match)) return `${match.split(/\s+/)[0]} ${REDACTED}`;
      return REDACTED;
    });
  }
  return out.replace(
    KEY_VALUE,
    (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
  );
}

/** True when an object key names a secret (its value is dropped by redactDeep). */
export function isSecretKey(key: string): boolean {
  return SECRET_FIELD.test(key);
}

/** Deep-redact a structured value (objects, arrays, strings, errors). Returns a new value. */
export function redactDeep<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") return key !== undefined && isSecretKey(key) ? REDACTED : redact(v);
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Date) return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => walk(item));
    if (v instanceof Error) {
      return { name: v.name, message: redact(v.message), ...(walk({ ...v }) as Record<string, unknown>) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
      if (k.toLowerCase() === "headers" && inner !== null && typeof inner === "object") {
        const headers: Record<string, unknown> = {};
        for (const [hk, hv] of Object.entries(inner as Record<string, unknown>)) {
          headers[hk] = SECRET_HEADER.test(hk) ? REDACTED : walk(hv, hk);
        }
        out[k] = headers;
      } else {
        out[k] = walk(inner, k);
      }
    }
    return out;
  };
  return walk(value) as T;
}
