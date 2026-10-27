import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { StorageBody } from "@studix/core";
import { StudixError } from "@studix/shared";

/**
 * Upload bodies are made concrete (bytes or a local file with known size and sha256) before anything is
 * sent, so a hash mismatch is rejected without ever writing a bad object and S3 always gets a
 * Content-Length. Web streams are spooled to a private temp file for that reason.
 */
export type MaterializedBody =
  | { kind: "bytes"; bytes: Uint8Array; size: number; sha256: string }
  | { kind: "file"; path: string; size: number; sha256: string; cleanup(): Promise<void> };

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Pass-through stream that counts and hashes everything flowing through it. */
export function createHashingTransform(): Transform & { digest(): { sha256: string; bytes: number } } {
  const hash = createHash("sha256");
  let bytes = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  return Object.assign(transform, { digest: () => ({ sha256: hash.digest("hex"), bytes }) });
}

export async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hasher = createHashingTransform();
  await pipeline(createReadStream(filePath), hasher, async (source) => {
    for await (const _ of source) {
      // drain: the transform already hashed the chunk
    }
  });
  return hasher.digest();
}

/**
 * Stream into `filePath` atomically: data lands in a sibling temp file that is renamed into place only
 * after the stream finished, so a failed or aborted download never leaves a truncated file behind.
 */
export async function writeStreamToFile(
  source: Readable | WebReadableStream<Uint8Array> | ReadableStream<Uint8Array>,
  filePath: string,
): Promise<{ sha256: string; bytes: number }> {
  if (!isAbsolute(filePath)) {
    throw new StudixError("VALIDATION", "Download target must be an absolute path", {
      details: { filePath },
    });
  }
  await mkdir(dirname(filePath), { recursive: true });
  const partial = `${filePath}.part-${randomBytes(6).toString("hex")}`;
  const hasher = createHashingTransform();
  const readable =
    source instanceof Readable ? source : Readable.fromWeb(source as WebReadableStream<Uint8Array>);
  try {
    await pipeline(readable, hasher, createWriteStream(partial));
    await rename(partial, filePath);
  } catch (err) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw err;
  }
  return hasher.digest();
}

export function assertExpectedSha256(expected: string | undefined, actual: string): void {
  if (expected === undefined) return;
  if (!SHA256_PATTERN.test(expected)) {
    throw new StudixError("VALIDATION", "Expected sha256 must be 64 lowercase hex characters");
  }
  if (expected !== actual) {
    throw new StudixError("VALIDATION", "Upload sha256 does not match the expected hash", {
      details: { expected, actual },
      retryable: false,
      suggestedAction: "Re-read the source file; it changed or was corrupted before upload.",
    });
  }
}

export async function materializeBody(body: StorageBody): Promise<MaterializedBody> {
  if (body instanceof Uint8Array) {
    return { kind: "bytes", bytes: body, size: body.byteLength, sha256: sha256Hex(body) };
  }
  if ("filePath" in body) {
    const { filePath } = body;
    if (typeof filePath !== "string" || !isAbsolute(filePath)) {
      throw new StudixError("VALIDATION", "Upload filePath must be an absolute path");
    }
    const info = await stat(filePath).catch((err: unknown) => {
      throw new StudixError("NOT_FOUND", "Upload source file does not exist", { cause: err });
    });
    if (!info.isFile()) throw new StudixError("VALIDATION", "Upload source is not a regular file");
    const { sha256, bytes } = await sha256File(filePath);
    return { kind: "file", path: filePath, size: bytes, sha256, cleanup: async () => undefined };
  }
  if (typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const dir = await mkdtemp(join(tmpdir(), "studix-upload-"));
    const cleanup = () => rm(dir, { recursive: true, force: true });
    try {
      const path = join(dir, "body");
      const { sha256, bytes } = await writeStreamToFile(body as ReadableStream<Uint8Array>, path);
      return { kind: "file", path, size: bytes, sha256, cleanup };
    } catch (err) {
      await cleanup();
      throw err;
    }
  }
  throw new StudixError("VALIDATION", "Unsupported storage body; pass bytes, a ReadableStream or {filePath}");
}

/** Bytes of a materialized body (used by the in-memory adapter). */
export async function readMaterialized(body: MaterializedBody): Promise<Uint8Array> {
  if (body.kind === "bytes") return body.bytes;
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(body.path)) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}
