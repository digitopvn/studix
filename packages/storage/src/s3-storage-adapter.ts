import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  PutObjectOptions,
  SignedUrlOptions,
  StorageAdapter,
  StorageBody,
  StoredObject,
  TenantContext,
} from "@studix/core";
import { redact, type StudixConfig, StudixError } from "@studix/shared";
import {
  assertSignedUrlPolicy,
  attachmentDisposition,
  resolveSignedUrlTtl,
  type SignedUrlPolicy,
} from "./signed-url-options.ts";
import { assertExpectedSha256, materializeBody, writeStreamToFile } from "./storage-body.ts";
import { assertContentType, resolveTenantKey, tenantPrefix } from "./tenant-storage-key.ts";

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** S3-compatible endpoint (R2, MinIO). Omit for AWS S3. */
  endpoint?: string;
  /**
   * Endpoint used only when signing URLs handed to clients, for setups where the worker reaches storage
   * on an internal host (e.g. `http://minio:9000`) but browsers need the public one.
   */
  publicEndpoint?: string;
  /** Path-style addressing (`endpoint/bucket/key`); required by MinIO, harmless for R2. */
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  signedUrlPolicy?: SignedUrlPolicy;
}

const DEFAULT_POLICY: SignedUrlPolicy = { defaultTtlSeconds: 3600, maxTtlSeconds: 86_400 };
/** Object metadata key carrying the content hash (S3 lowercases user metadata keys). */
const SHA256_METADATA = "sha256";
/** How long a passed write probe is trusted before the next job probes again. */
const WRITE_PROBE_TTL_MS = 60_000;

function isNotFound(err: unknown): boolean {
  return (
    err instanceof S3ServiceException &&
    (err.name === "NotFound" || err.name === "NoSuchKey" || err.$metadata.httpStatusCode === 404)
  );
}

function storageError(action: string, err: unknown): StudixError {
  if (err instanceof StudixError) return err;
  const status = err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return new StudixError("UNAVAILABLE", `Object storage ${action} failed: ${redact(message)}`, {
    cause: err,
    retryable: status === undefined || status >= 500 || status === 429,
    details: { action, status },
    suggestedAction:
      status === 401 || status === 403
        ? "The storage credentials were rejected. Check that S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are current and allow PutObject, GetObject, HeadObject and DeleteObject on S3_BUCKET under the orgs/ prefix, then retry the job: it resumes from the stored render."
        : "Check S3_ENDPOINT, S3_BUCKET and credentials, then retry.",
  });
}

function buildClient(options: S3StorageOptions, endpoint: string | undefined): S3Client {
  return new S3Client({
    region: options.region,
    endpoint,
    forcePathStyle: options.forcePathStyle ?? false,
    credentials: options.credentials,
    // S3-compatible stores (R2, older MinIO) do not all accept the SDK's default trailing CRC checksums.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** StorageAdapter over the S3 API (Cloudflare R2, MinIO, AWS S3). Buckets stay private; reads use signed URLs. */
export class S3StorageAdapter implements StorageAdapter {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly signer: S3Client;
  private readonly policy: SignedUrlPolicy;
  private readonly probedUntil = new Map<string, number>();

  constructor(options: S3StorageOptions) {
    if (!options.bucket) throw new StudixError("VALIDATION", "S3 bucket is not configured");
    if (!options.region) throw new StudixError("VALIDATION", "S3 region is not configured");
    this.bucket = options.bucket;
    this.policy = assertSignedUrlPolicy(options.signedUrlPolicy ?? DEFAULT_POLICY);
    this.client = buildClient(options, options.endpoint);
    this.signer = options.publicEndpoint ? buildClient(options, options.publicEndpoint) : this.client;
  }

  async put(
    ctx: TenantContext,
    key: string,
    body: StorageBody,
    options: PutObjectOptions,
  ): Promise<StoredObject> {
    const objectKey = resolveTenantKey(ctx, key);
    assertContentType(options.contentType);
    const material = await materializeBody(body);
    try {
      assertExpectedSha256(options.sha256, material.sha256);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: material.kind === "bytes" ? material.bytes : createReadStream(material.path),
          ContentLength: material.size,
          ContentType: options.contentType,
          CacheControl: options.cacheControl,
          Metadata: { [SHA256_METADATA]: material.sha256 },
        }),
      );
    } catch (err) {
      throw storageError("put", err);
    } finally {
      if (material.kind === "file") await material.cleanup();
    }
    return { key, bytes: material.size, sha256: material.sha256, contentType: options.contentType };
  }

  async get(
    ctx: TenantContext,
    key: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; bytes: number }> {
    const objectKey = resolveTenantKey(ctx, key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      if (!out.Body) throw new StudixError("NOT_FOUND", "Object not found", { details: { key } });
      return {
        body: out.Body.transformToWebStream() as ReadableStream<Uint8Array>,
        contentType: out.ContentType ?? "application/octet-stream",
        bytes: out.ContentLength ?? 0,
      };
    } catch (err) {
      if (isNotFound(err)) throw new StudixError("NOT_FOUND", "Object not found", { details: { key } });
      throw storageError("get", err);
    }
  }

  async download(
    ctx: TenantContext,
    key: string,
    filePath: string,
  ): Promise<{ sha256: string; bytes: number }> {
    const { body } = await this.get(ctx, key);
    try {
      return await writeStreamToFile(body, filePath);
    } catch (err) {
      throw storageError("download", err);
    }
  }

  async head(ctx: TenantContext, key: string): Promise<StoredObject | undefined> {
    const objectKey = resolveTenantKey(ctx, key);
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return {
        key,
        bytes: out.ContentLength ?? 0,
        // Every object written through this adapter carries the hash; an empty string marks a foreign object.
        sha256: out.Metadata?.[SHA256_METADATA] ?? "",
        contentType: out.ContentType ?? "application/octet-stream",
      };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw storageError("head", err);
    }
  }

  async signedUrl(ctx: TenantContext, key: string, options: SignedUrlOptions = {}): Promise<string> {
    const objectKey = resolveTenantKey(ctx, key);
    const expiresIn = resolveSignedUrlTtl(options.expiresInSeconds, this.policy);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ResponseContentDisposition:
        options.downloadName === undefined ? undefined : attachmentDisposition(options.downloadName),
    });
    try {
      return await getSignedUrl(this.signer, command, { expiresIn });
    } catch (err) {
      throw storageError("sign", err);
    }
  }

  async delete(ctx: TenantContext, key: string): Promise<void> {
    const objectKey = resolveTenantKey(ctx, key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    } catch (err) {
      if (isNotFound(err)) return;
      throw storageError("delete", err);
    }
  }

  async verifyWritable(ctx: Pick<TenantContext, "organizationId" | "workspaceId">): Promise<void> {
    const prefix = tenantPrefix(ctx);
    if ((this.probedUntil.get(prefix) ?? 0) > Date.now()) return;
    const key = `preflight/${randomUUID()}.txt`;
    const body = new TextEncoder().encode("studix storage preflight");
    await this.put(ctx as TenantContext, key, body, { contentType: "text/plain" });
    try {
      const stored = await this.head(ctx as TenantContext, key);
      if (!stored) {
        throw new StudixError(
          "UNAVAILABLE",
          "Object storage accepted a write but the object is not readable",
          {
            retryable: true,
            details: { action: "preflight" },
            suggestedAction:
              "Check that S3_ENDPOINT and S3_BUCKET point at the same store the credentials belong to.",
          },
        );
      }
    } finally {
      // A leftover probe object is harmless, so a failed delete must not mask the real result.
      await this.delete(ctx as TenantContext, key).catch(() => undefined);
    }
    this.probedUntil.set(prefix, Date.now() + WRITE_PROBE_TTL_MS);
  }

  /** Release sockets held by the SDK clients. */
  destroy(): void {
    this.client.destroy();
    if (this.signer !== this.client) this.signer.destroy();
  }
}

/**
 * Build the adapter from loaded configuration (never from process.env directly). The signed URL default
 * comes from S3_SIGNED_URL_TTL_SECONDS and doubles as the ceiling, so clients cannot ask for longer.
 */
export function createS3StorageAdapterFromConfig(
  config: Pick<
    StudixConfig,
    | "S3_ENDPOINT"
    | "S3_PUBLIC_ENDPOINT"
    | "S3_REGION"
    | "S3_BUCKET"
    | "S3_ACCESS_KEY_ID"
    | "S3_SECRET_ACCESS_KEY"
    | "S3_FORCE_PATH_STYLE"
    | "S3_SIGNED_URL_TTL_SECONDS"
  >,
  overrides: Partial<Pick<S3StorageOptions, "publicEndpoint" | "signedUrlPolicy">> = {},
): S3StorageAdapter {
  if (!config.S3_BUCKET) {
    throw new StudixError("VALIDATION", "S3_BUCKET is not configured", {
      suggestedAction: "Set S3_BUCKET (and S3_ENDPOINT for R2/MinIO); see .env.example.",
    });
  }
  const hasKeyId = Boolean(config.S3_ACCESS_KEY_ID);
  if (hasKeyId !== Boolean(config.S3_SECRET_ACCESS_KEY)) {
    throw new StudixError("VALIDATION", "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together");
  }
  const ttl = config.S3_SIGNED_URL_TTL_SECONDS;
  return new S3StorageAdapter({
    bucket: config.S3_BUCKET,
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: hasKeyId
      ? { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! }
      : undefined,
    signedUrlPolicy: overrides.signedUrlPolicy ?? { defaultTtlSeconds: ttl, maxTtlSeconds: ttl },
    publicEndpoint: overrides.publicEndpoint ?? config.S3_PUBLIC_ENDPOINT,
  });
}
