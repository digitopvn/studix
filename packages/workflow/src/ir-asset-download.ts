import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { StorageAdapter, TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import type { VideoIR } from "@studix/video-ir";

/**
 * Download every IR asset from tenant storage into `dir` and verify its pinned sha256, returning the
 * asset id -> local path map renderers expect. The worker never fetches arbitrary URIs (SSRF surface);
 * assets must be imported into storage first.
 */
export async function downloadIrAssets(
  storage: StorageAdapter,
  ctx: TenantContext,
  ir: VideoIR,
  dir: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  if (ir.assets.length === 0) return files;
  await mkdir(dir, { recursive: true });
  for (const asset of ir.assets) {
    if (!asset.storageKey) {
      throw new StudixError(
        "VALIDATION",
        `Asset ${asset.id} has no storageKey; external URIs are not fetched`,
        {
          retryable: false,
          details: { assetId: asset.id },
          suggestedAction:
            "Upload or import the asset into the workspace library and reference its storageKey.",
        },
      );
    }
    const filePath = join(dir, `${asset.id}${extname(asset.storageKey)}`);
    const { sha256 } = await storage.download(ctx, asset.storageKey, filePath);
    if (sha256 !== asset.sha256) {
      throw new StudixError("VALIDATION", `Asset ${asset.id} content does not match its sha256`, {
        retryable: false,
        details: { assetId: asset.id, expected: asset.sha256, actual: sha256 },
      });
    }
    files[asset.id] = filePath;
  }
  return files;
}
