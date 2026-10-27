import type {
  PutObjectOptions,
  SignedUrlOptions,
  StorageAdapter,
  StorageBody,
  StoredObject,
  TenantContext,
} from "@studix/core";
import { type Clock, StudixError, systemClock } from "@studix/shared";
import { assertSignedUrlPolicy, resolveSignedUrlTtl, type SignedUrlPolicy } from "./signed-url-options.ts";
import {
  assertExpectedSha256,
  materializeBody,
  readMaterialized,
  writeStreamToFile,
} from "./storage-body.ts";
import { assertContentType, resolveTenantKey } from "./tenant-storage-key.ts";

interface MemoryObject {
  bytes: Uint8Array;
  sha256: string;
  contentType: string;
}

export interface InMemoryStorageOptions {
  clock?: Clock;
  signedUrlPolicy?: SignedUrlPolicy;
}

/**
 * StorageAdapter kept in process memory for unit tests and local fakes. It enforces the same tenant-key
 * and hash rules as the S3 adapter; signed URLs use a `memory://` scheme that only this adapter resolves.
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<string, MemoryObject>();
  private readonly clock: Clock;
  private readonly policy: SignedUrlPolicy;

  constructor(options: InMemoryStorageOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.policy = assertSignedUrlPolicy(
      options.signedUrlPolicy ?? { defaultTtlSeconds: 3600, maxTtlSeconds: 86_400 },
    );
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
      const bytes = await readMaterialized(material);
      // Copy so later mutation of the caller's buffer cannot change the stored object.
      this.objects.set(objectKey, {
        bytes: bytes.slice(),
        sha256: material.sha256,
        contentType: options.contentType,
      });
      return { key, bytes: bytes.byteLength, sha256: material.sha256, contentType: options.contentType };
    } finally {
      if (material.kind === "file") await material.cleanup();
    }
  }

  async get(
    ctx: TenantContext,
    key: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; bytes: number }> {
    const object = this.require(ctx, key);
    const copy = object.bytes.slice();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(copy);
        controller.close();
      },
    });
    return { body, contentType: object.contentType, bytes: copy.byteLength };
  }

  async download(
    ctx: TenantContext,
    key: string,
    filePath: string,
  ): Promise<{ sha256: string; bytes: number }> {
    const { body } = await this.get(ctx, key);
    return writeStreamToFile(body, filePath);
  }

  async head(ctx: TenantContext, key: string): Promise<StoredObject | undefined> {
    const object = this.objects.get(resolveTenantKey(ctx, key));
    if (!object) return undefined;
    return { key, bytes: object.bytes.byteLength, sha256: object.sha256, contentType: object.contentType };
  }

  async signedUrl(ctx: TenantContext, key: string, options: SignedUrlOptions = {}): Promise<string> {
    const objectKey = resolveTenantKey(ctx, key);
    this.require(ctx, key);
    const ttl = resolveSignedUrlTtl(options.expiresInSeconds, this.policy);
    const expires = Math.floor(this.clock.now().getTime() / 1000) + ttl;
    const url = new URL(`memory://storage/${objectKey}`);
    url.searchParams.set("expires", String(expires));
    if (options.downloadName) url.searchParams.set("download", options.downloadName);
    return url.toString();
  }

  async delete(ctx: TenantContext, key: string): Promise<void> {
    this.objects.delete(resolveTenantKey(ctx, key));
  }

  /** Absolute keys currently stored (for tests asserting tenant prefixes). */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  private require(ctx: TenantContext, key: string): MemoryObject {
    const object = this.objects.get(resolveTenantKey(ctx, key));
    if (!object) throw new StudixError("NOT_FOUND", "Object not found", { details: { key } });
    return object;
  }
}
