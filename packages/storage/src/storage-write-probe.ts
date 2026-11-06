import { randomUUID } from "node:crypto";
import type { StorageAdapter, TenantContext } from "@studix/core";
import { redact, StudixError } from "@studix/shared";

/**
 * Tenant used only for the probe object. It follows the same `orgs/<org>/workspaces/<ws>/` layout as real
 * artifacts, so a bucket policy or credential scoped to that prefix is exercised the way production writes are.
 */
const PROBE_TENANT: TenantContext = {
  organizationId: "storage-probe",
  workspaceId: "storage-probe",
  actor: { type: "system", id: "storage-probe" },
};

export type StorageProbeStep = "put" | "head" | "get" | "delete";

export interface StorageProbeResult {
  ok: boolean;
  /** Step that failed; absent when ok. */
  step?: StorageProbeStep;
  /** HTTP status reported by the store, when there was one (e.g. 403 for a denied PutObject). */
  status?: number;
  /** Redacted failure message, never contains credentials. */
  message?: string;
  /** What an operator should check first for this failure. */
  hint?: string;
  durationMs: number;
}

function hintFor(status: number | undefined): string {
  if (status === 403) {
    return "Store rejected the request: check S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY (rotated or wrong environment), the key's PutObject/GetObject/DeleteObject permission on S3_BUCKET, and any bucket policy limiting the orgs/ prefix.";
  }
  if (status === 404) return "Bucket not found: check S3_BUCKET, S3_ENDPOINT and S3_FORCE_PATH_STYLE.";
  if (status === undefined) return "Store unreachable: check S3_ENDPOINT, S3_REGION and network egress.";
  return "Check S3_ENDPOINT, S3_BUCKET and credentials.";
}

/**
 * Write, stat, read and delete one tiny temporary object. A misconfigured bucket or key fails here, at worker
 * startup and in `/readyz`, instead of after a job has spent minutes rendering. Never throws.
 */
export async function probeStorageWriteAccess(
  storage: StorageAdapter,
  now: () => number = Date.now,
): Promise<StorageProbeResult> {
  const started = now();
  const key = `healthcheck/${randomUUID()}.txt`;
  const payload = new TextEncoder().encode("studix storage probe");
  let step: StorageProbeStep = "put";
  let created = false;
  try {
    await storage.put(PROBE_TENANT, key, payload, { contentType: "text/plain" });
    created = true;
    step = "head";
    const head = await storage.head(PROBE_TENANT, key);
    if (!head) throw new StudixError("UNAVAILABLE", "probe object not visible after write");
    step = "get";
    const { body } = await storage.get(PROBE_TENANT, key);
    await body.cancel();
    step = "delete";
    await storage.delete(PROBE_TENANT, key);
    created = false;
    return { ok: true, durationMs: now() - started };
  } catch (err) {
    const rawStatus =
      err instanceof StudixError ? (err.details as { status?: unknown } | undefined)?.status : undefined;
    const status = typeof rawStatus === "number" ? rawStatus : undefined;
    // Leave nothing behind when only a later step failed.
    if (created) await storage.delete(PROBE_TENANT, key).catch(() => undefined);
    return {
      ok: false,
      step,
      status,
      message: redact(err instanceof Error ? err.message : String(err)),
      hint: hintFor(status),
      durationMs: now() - started,
    };
  }
}
