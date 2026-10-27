import { StudixError } from "@studix/shared";

/** Hard ceiling for any signed URL: S3 SigV4 rejects presigned URLs valid for more than 7 days. */
export const MAX_SIGNED_URL_TTL_SECONDS = 604_800;
export const MIN_SIGNED_URL_TTL_SECONDS = 1;

export interface SignedUrlPolicy {
  /** TTL used when the caller does not ask for one. */
  defaultTtlSeconds: number;
  /** Longest TTL a caller may request (<= 7 days). */
  maxTtlSeconds: number;
}

export function assertSignedUrlPolicy(policy: SignedUrlPolicy): SignedUrlPolicy {
  const { defaultTtlSeconds, maxTtlSeconds } = policy;
  const valid =
    Number.isInteger(maxTtlSeconds) &&
    maxTtlSeconds >= MIN_SIGNED_URL_TTL_SECONDS &&
    maxTtlSeconds <= MAX_SIGNED_URL_TTL_SECONDS &&
    Number.isInteger(defaultTtlSeconds) &&
    defaultTtlSeconds >= MIN_SIGNED_URL_TTL_SECONDS &&
    defaultTtlSeconds <= maxTtlSeconds;
  if (!valid) {
    throw new StudixError("VALIDATION", "Invalid signed URL TTL policy", {
      details: { defaultTtlSeconds, maxTtlSeconds },
      suggestedAction: `Use 1 <= default <= max <= ${MAX_SIGNED_URL_TTL_SECONDS} seconds.`,
    });
  }
  return policy;
}

/** Requested TTL checked against the policy; out-of-range requests fail instead of being silently clamped. */
export function resolveSignedUrlTtl(requested: number | undefined, policy: SignedUrlPolicy): number {
  if (requested === undefined) return policy.defaultTtlSeconds;
  if (
    !Number.isInteger(requested) ||
    requested < MIN_SIGNED_URL_TTL_SECONDS ||
    requested > policy.maxTtlSeconds
  ) {
    throw new StudixError("VALIDATION", "Signed URL expiry is out of range", {
      details: { expiresInSeconds: requested, maxTtlSeconds: policy.maxTtlSeconds },
      suggestedAction: `Request between ${MIN_SIGNED_URL_TTL_SECONDS} and ${policy.maxTtlSeconds} seconds.`,
    });
  }
  return requested;
}

/**
 * `Content-Disposition: attachment` with an ASCII fallback plus an RFC 5987 UTF-8 filename, so names
 * like "giới-thiệu.mp4" survive download without header injection (quotes, CR/LF are stripped).
 */
export function attachmentDisposition(downloadName: string): string {
  const cleaned = downloadName
    .replace(/[\r\n"\\/]/g, "")
    .trim()
    .slice(0, 200);
  if (cleaned === "") throw new StudixError("VALIDATION", "downloadName is empty after sanitizing");
  // ASCII fallback for legacy clients only; filename* carries the exact UTF-8 name.
  const ascii = cleaned
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
