import { createHash } from "node:crypto";
import type { GitHubSession } from "./github-client.ts";
import { BlobResponse } from "./github-schemas.ts";
import type { RepoRef } from "./github-tree.ts";

export type BlobResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Decode base64 content whose declared size was already checked; `undefined` when it does not match. */
export function decodeBase64(content: string, expectedBytes: number): Uint8Array | undefined {
  // Base64 is 4/3 the size plus line breaks; refuse anything far larger before allocating.
  if (content.length > Math.ceil(expectedBytes / 3) * 4 + Math.ceil(expectedBytes / 32) + 16) return undefined;
  const bytes = new Uint8Array(Buffer.from(content, "base64"));
  return bytes.length === expectedBytes ? bytes : undefined;
}

/** Strict UTF-8 text without NUL bytes, or `undefined` for anything binary. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Download one blob by its sha. The size is checked against `maxBytes` before anything is decoded, and
 * the decoded bytes must hash to the requested git blob sha, so content always matches the pinned tree.
 */
export async function downloadBlob(
  session: GitHubSession,
  ref: RepoRef,
  sha: string,
  maxBytes: number,
): Promise<BlobResult> {
  const blob = await session.getJson(BlobResponse, ["repos", ref.owner, ref.repo, "git", "blobs", sha]);
  if (blob.size > maxBytes) return { ok: false, reason: `too large (${blob.size} bytes, limit ${maxBytes})` };
  if (blob.encoding !== "base64") return { ok: false, reason: "unsupported blob encoding" };
  const bytes = decodeBase64(blob.content, blob.size);
  if (!bytes) return { ok: false, reason: "blob content does not match its size" };
  const gitSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (gitSha !== sha) return { ok: false, reason: "blob content does not match its sha" };
  return { ok: true, bytes };
}
