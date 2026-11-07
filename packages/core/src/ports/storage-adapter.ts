import { StudixError } from "@studix/shared";
import type { TenantContext } from "../tenant.ts";

export type StorageBody = Uint8Array | ReadableStream<Uint8Array> | { filePath: string };

export interface PutObjectOptions {
  contentType: string;
  /** Expected sha256 (hex); the adapter rejects the upload on mismatch. */
  sha256?: string;
  cacheControl?: string;
}

export interface StoredObject {
  /** Tenant-relative key as passed by the caller. */
  key: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export interface SignedUrlOptions {
  expiresInSeconds?: number;
  /** Suggested download filename (Content-Disposition attachment). */
  downloadName?: string;
}

export interface SignedUploadUrlOptions {
  /** The client must send this Content-Type. */
  contentType: string;
  expiresInSeconds?: number;
}

/**
 * Object storage scoped to a tenant. Callers pass tenant-relative keys; adapters prefix them with
 * tenantObjectKey(ctx, key) so one workspace can never address another's objects.
 */
export interface StorageAdapter {
  put(ctx: TenantContext, key: string, body: StorageBody, options: PutObjectOptions): Promise<StoredObject>;
  get(
    ctx: TenantContext,
    key: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; bytes: number }>;
  /** Download to a local file (renderers need files); returns the sha256 of the written bytes. */
  download(ctx: TenantContext, key: string, filePath: string): Promise<{ sha256: string; bytes: number }>;
  head(ctx: TenantContext, key: string): Promise<StoredObject | undefined>;
  signedUrl(ctx: TenantContext, key: string, options?: SignedUrlOptions): Promise<string>;
  /**
   * Short-lived URL a client can PUT one object to. The store cannot cap the size, so whoever reads the
   * object afterwards must check `head().bytes` first. Optional: adapters without it cannot take uploads.
   */
  signedUploadUrl?(ctx: TenantContext, key: string, options: SignedUploadUrlOptions): Promise<string>;
  delete(ctx: TenantContext, key: string): Promise<void>;
}

const KEY_PATTERN = /^[A-Za-z0-9][\w\-./]*$/;

/** Validate a tenant-relative key: no absolute paths, traversal, empty segments or control chars. */
export function assertRelativeStorageKey(key: string): void {
  const ok =
    key.length > 0 &&
    key.length <= 512 &&
    KEY_PATTERN.test(key) &&
    !key.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
  if (!ok) {
    throw new StudixError("VALIDATION", "Invalid storage key", {
      details: { key },
      suggestedAction: "Use a relative key like assets/<assetId>/v1/file.png",
    });
  }
}

/** Absolute object key for a tenant: `orgs/<org>/workspaces/<ws>/<key>`. */
export function tenantObjectKey(
  ctx: Pick<TenantContext, "organizationId" | "workspaceId">,
  key: string,
): string {
  assertRelativeStorageKey(key);
  return `orgs/${ctx.organizationId}/workspaces/${ctx.workspaceId}/${key}`;
}
