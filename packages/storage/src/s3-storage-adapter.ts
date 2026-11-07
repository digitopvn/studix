import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { LookupFunction } from "node:net";
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
  SignedUploadUrlOptions,
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
import { assertContentType, resolveTenantKey } from "./tenant-storage-key.ts";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Credentials read again whenever the SDK needs them (at most every `CREDENTIAL_REFRESH_MS`), so a key an
 * operator rotates from the dashboard applies without a restart.
 */
export type S3CredentialSource = () => Promise<S3Credentials>;

/**
 * The SDK memoizes a provider's identity until it is within five minutes of `expiration`; an identity
 * without one is kept for the life of the client. Declaring one just past that window makes the SDK call the
 * source again after this long.
 */
export const CREDENTIAL_REFRESH_MS = 15_000;
const SDK_EXPIRY_WINDOW_MS = 5 * 60_000;

function credentialProvider(source: S3Credentials | S3CredentialSource | undefined) {
  if (source === undefined || typeof source !== "function") return source;
  return async () => ({
    ...(await source()),
    expiration: new Date(Date.now() + SDK_EXPIRY_WINDOW_MS + CREDENTIAL_REFRESH_MS),
  });
}

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
  credentials?: S3Credentials | S3CredentialSource;
  signedUrlPolicy?: SignedUrlPolicy;
  /** Prepended to every object key (`studix/` ...), so one bucket can be shared with other data. */
  keyPrefix?: string;
  /** Socket address lookup; a guarded one refuses private addresses on every connection (see endpoint-guard). */
  lookup?: LookupFunction;
}

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][\w\-.]*(\/[A-Za-z0-9][\w\-.]*)*\/$/;

/** A key prefix is empty or relative segments ending in `/`, without `.`/`..` segments. */
export function assertKeyPrefix(prefix: string): void {
  const ok =
    prefix === "" ||
    (prefix.length <= 128 &&
      KEY_PREFIX_PATTERN.test(prefix) &&
      !prefix.split("/").some((segment) => segment === "." || segment === ".."));
  if (!ok) {
    throw new StudixError("VALIDATION", "Invalid key prefix", {
      retryable: false,
      details: { field: "keyPrefix" },
      suggestedAction: "Use relative segments ending in a slash, e.g. studix/ or prod/media/.",
    });
  }
}

const DEFAULT_POLICY: SignedUrlPolicy = { defaultTtlSeconds: 3600, maxTtlSeconds: 86_400 };
/** Object metadata key carrying the content hash (S3 lowercases user metadata keys). */
const SHA256_METADATA = "sha256";

function isNotFound(err: unknown): boolean {
  return (
    err instanceof S3ServiceException &&
    (err.name === "NotFound" || err.name === "NoSuchKey" || err.$metadata.httpStatusCode === 404)
  );
}

const DENIED_HINT =
  "The store rejected the credentials or the bucket policy (HTTP 401/403). Check that S3_ACCESS_KEY_ID / " +
  "S3_SECRET_ACCESS_KEY belong to this bucket, were not rotated, and may write under orgs/*; also check " +
  "S3_ENDPOINT, S3_REGION and S3_FORCE_PATH_STYLE. Restart the worker to re-run the startup write probe (its result is in the logs and in the worker /readyz), then retry the job.";

function storageError(action: string, err: unknown): StudixError {
  if (err instanceof StudixError) return err;
  const status = err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
  const s3Code = err instanceof S3ServiceException ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const denied = status === 401 || status === 403;
  return new StudixError("UNAVAILABLE", `Object storage ${action} failed: ${redact(message)}`, {
    cause: err,
    retryable: status === undefined || status >= 500 || status === 429,
    details: { action, status, ...(s3Code ? { s3Code } : {}) },
    suggestedAction: denied ? DENIED_HINT : "Check S3_ENDPOINT, S3_BUCKET and credentials, then retry.",
  });
}

export interface StorageProbeResult {
  ok: boolean;
  /** Step that failed: `put`, `get`, `head` or `delete`. */
  step?: "put" | "get" | "head" | "delete";
  status?: number;
  s3Code?: string;
  /** True when the failure is a definitive refusal (4xx other than 429) rather than a transient outage. */
  denied?: boolean;
  message?: string;
}

/**
 * Tenant-shaped prefix for probe objects, so a bucket policy that only allows `orgs/*` is exercised the same
 * way real renders are.
 */
const PROBE_TENANT = { organizationId: "healthcheck", workspaceId: "probe" };

function buildClient(options: S3StorageOptions, endpoint: string | undefined): S3Client {
  return new S3Client({
    region: options.region,
    endpoint,
    forcePathStyle: options.forcePathStyle ?? false,
    credentials: credentialProvider(options.credentials),
    // No redirects are followed by the SDK; the guarded lookup also refuses private addresses per connection.
    ...(options.lookup
      ? {
          requestHandler: {
            httpAgent: new HttpAgent({ keepAlive: true, lookup: options.lookup }),
            httpsAgent: new HttpsAgent({ keepAlive: true, lookup: options.lookup }),
          },
        }
      : {}),
    // S3-compatible stores (R2, older MinIO) do not all accept the SDK's default trailing CRC checksums.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** StorageAdapter over the S3 API (Cloudflare R2, MinIO, AWS S3). Buckets stay private; reads use signed URLs. */
/** The object read back is not what the probe wrote: something between us and the bucket changed it. */
class ProbeBodyMismatch extends Error {
  constructor() {
    super("The object read back differs from what was written");
  }
}

export class S3StorageAdapter implements StorageAdapter {
  readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly client: S3Client;
  private readonly signer: S3Client;
  private readonly policy: SignedUrlPolicy;

  constructor(options: S3StorageOptions) {
    if (!options.bucket) throw new StudixError("VALIDATION", "S3 bucket is not configured");
    if (!options.region) throw new StudixError("VALIDATION", "S3 region is not configured");
    this.bucket = options.bucket;
    this.keyPrefix = options.keyPrefix ?? "";
    assertKeyPrefix(this.keyPrefix);
    this.policy = assertSignedUrlPolicy(options.signedUrlPolicy ?? DEFAULT_POLICY);
    this.client = buildClient(options, options.endpoint);
    this.signer = options.publicEndpoint ? buildClient(options, options.publicEndpoint) : this.client;
  }

  private objectKey(ctx: TenantContext, key: string): string {
    return this.keyPrefix + resolveTenantKey(ctx, key);
  }

  async put(
    ctx: TenantContext,
    key: string,
    body: StorageBody,
    options: PutObjectOptions,
  ): Promise<StoredObject> {
    const objectKey = this.objectKey(ctx, key);
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
    const objectKey = this.objectKey(ctx, key);
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
    const objectKey = this.objectKey(ctx, key);
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
    const objectKey = this.objectKey(ctx, key);
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

  async signedUploadUrl(ctx: TenantContext, key: string, options: SignedUploadUrlOptions): Promise<string> {
    const objectKey = this.objectKey(ctx, key);
    assertContentType(options.contentType);
    const expiresIn = resolveSignedUrlTtl(options.expiresInSeconds, this.policy);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: options.contentType,
    });
    try {
      return await getSignedUrl(this.signer, command, { expiresIn });
    } catch (err) {
      throw storageError("sign", err);
    }
  }

  async delete(ctx: TenantContext, key: string): Promise<void> {
    const objectKey = this.objectKey(ctx, key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    } catch (err) {
      if (isNotFound(err)) return;
      throw storageError("delete", err);
    }
  }

  /**
   * Write, read (get and head) and delete one tiny temporary object under a tenant-shaped prefix. Never throws; the
   * result carries only the failing step, HTTP status and S3 error code (no credentials or bucket names).
   */
  async probeWrite(): Promise<StorageProbeResult> {
    const key = this.keyPrefix + resolveTenantKey(PROBE_TENANT, `probe/${randomUUID()}.txt`);
    const body = new TextEncoder().encode("studix storage probe");
    let step: "put" | "get" | "head" | "delete" = "put";
    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: "text/plain" }),
      );
      step = "get";
      const read = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const echoed = (await read.Body?.transformToString()) ?? "";
      if (echoed !== "studix storage probe") throw new ProbeBodyMismatch();
      step = "head";
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      step = "delete";
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return { ok: true };
    } catch (err) {
      const status = err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
      if (step !== "put") {
        // Best effort: do not leave the probe object behind when only a later step failed.
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => {});
      }
      return {
        ok: false,
        step,
        ...(status === undefined ? {} : { status }),
        ...(err instanceof S3ServiceException ? { s3Code: err.name } : {}),
        ...(err instanceof ProbeBodyMismatch ? { s3Code: "BodyMismatch" } : {}),
        denied: status !== undefined && status >= 400 && status < 500 && status !== 429,
        message: redact(err instanceof Error ? err.message : String(err)),
      };
    }
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
  overrides: Partial<Pick<S3StorageOptions, "publicEndpoint" | "signedUrlPolicy" | "credentials">> = {},
): S3StorageAdapter {
  if (!config.S3_BUCKET) {
    throw new StudixError("VALIDATION", "S3_BUCKET is not configured", {
      suggestedAction: "Set S3_BUCKET (and S3_ENDPOINT for R2/MinIO); see .env.example.",
    });
  }
  const hasKeyId = Boolean(config.S3_ACCESS_KEY_ID);
  if (!overrides.credentials && hasKeyId !== Boolean(config.S3_SECRET_ACCESS_KEY)) {
    throw new StudixError("VALIDATION", "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together");
  }
  const ttl = config.S3_SIGNED_URL_TTL_SECONDS;
  return new S3StorageAdapter({
    bucket: config.S3_BUCKET,
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials:
      overrides.credentials ??
      (hasKeyId
        ? { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! }
        : undefined),
    signedUrlPolicy: overrides.signedUrlPolicy ?? { defaultTtlSeconds: ttl, maxTtlSeconds: ttl },
    publicEndpoint: overrides.publicEndpoint ?? config.S3_PUBLIC_ENDPOINT,
  });
}

/**
 * Cached storage write probe for readiness endpoints. A healthy result is reused for `ttlMs`; a failure is
 * re-probed after `failureTtlMs` so a fixed configuration recovers quickly without hammering the store.
 */
export function createStorageWriteCheck(
  adapter: Pick<S3StorageAdapter, "probeWrite">,
  options: { ttlMs?: number; failureTtlMs?: number; now?: () => number } = {},
): () => Promise<StorageProbeResult> {
  const ttlMs = options.ttlMs ?? 60_000;
  const failureTtlMs = options.failureTtlMs ?? 10_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; result: StorageProbeResult } | undefined;
  let inflight: Promise<StorageProbeResult> | undefined;
  return async () => {
    if (cached && now() - cached.at < (cached.result.ok ? ttlMs : failureTtlMs)) return cached.result;
    inflight ??= adapter
      .probeWrite()
      .then((result) => {
        cached = { at: now(), result };
        return result;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}
