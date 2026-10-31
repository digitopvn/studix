import { extname } from "node:path";
import { USAGE_KINDS } from "@studix/billing";
import {
  type MediaCharge,
  MediaChargedError,
  type MediaGenerationRequest,
  type MediaGenerationResult,
  type MediaKind,
} from "@studix/core";
import { StudixError, toStudixError } from "@studix/shared";
import type { AssetMediaKind, AssetRef } from "@studix/video-ir";
import {
  requireService,
  type StageContext,
  StageFailedAfterSpend,
  type StageUsage,
  sha256File,
} from "@studix/workflow";

/** One media asset a pack stage generates and keeps in tenant storage. */
export interface StoredMediaRequest {
  /** IR asset id of the result; also names the upstream idempotency key, so keep it stable per job. */
  assetId: string;
  kind: MediaKind;
  prompt: string;
  params?: Record<string, unknown>;
  /** Storage key prefix; the file extension is appended. */
  keyPrefix: string;
  /** Upper bound for this one call (providers refuse rather than exceed it). */
  maxCostCents: number;
}

export interface StoredMedia {
  asset: AssetRef;
  /** The usage line of the call, tied to the upstream job so a resumed stage never bills it twice. */
  usage: StageUsage;
  /** Local copy in the stage work directory. */
  filePath: string;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/x-msvideo": ".avi",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
};

function assetKind(kind: MediaKind): AssetMediaKind {
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  return "audio";
}

/** The provider request of one stored asset; stages estimate with exactly what they will submit. */
export function mediaRequest(
  s: StageContext,
  stage: string,
  request: StoredMediaRequest,
  workDir: string,
): MediaGenerationRequest {
  return {
    kind: request.kind,
    prompt: request.prompt,
    ...(request.params ? { params: request.params } : {}),
    // Stable across attempts and workers: the stage journal resumes the upstream job under this key.
    idempotencyKey: `${s.job.id}:${stage}:${request.assetId}`,
    maxCostCents: request.maxCostCents,
    workDir,
    signal: s.signal,
    journal: s.mediaJournal,
  };
}

/** Sum of the provider's estimates for `requests`, in cents (the budget check before a paid stage). */
export async function estimateMediaCents(
  s: StageContext,
  requests: readonly Pick<StoredMediaRequest, "kind" | "prompt" | "params" | "maxCostCents">[],
): Promise<number> {
  const media = requireService(s, "media");
  let total = 0;
  for (const r of requests) {
    total += await media.estimateCostCents({
      kind: r.kind,
      prompt: r.prompt,
      maxCostCents: r.maxCostCents,
      ...(r.params ? { params: r.params } : {}),
    });
  }
  return total;
}

/** The usage line of a provider call that charged, whether it then returned or failed. */
function mediaUsage(request: StoredMediaRequest, charge: MediaCharge): StageUsage {
  const upstreamJob = charge.job ? `${charge.job.provider}:${charge.job.id}` : undefined;
  return {
    item: `media-${request.assetId}`,
    kind: USAGE_KINDS.mediaGeneration,
    quantity: 1,
    unit: request.kind,
    costCents: charge.costCents,
    ...(upstreamJob ? { upstreamJob } : {}),
    metadata: {
      provider: charge.provider,
      model: charge.model,
      mediaKind: request.kind,
      assetId: request.assetId,
      costSource: charge.costSource ?? "unknown",
      ...(upstreamJob ? { upstreamJob } : {}),
    },
  };
}

/**
 * Generate one asset with the worker's media provider, then store it in tenant storage and describe it as
 * an IR asset with provenance. The request carries the stage's durable journal, so a retry on any worker
 * collects the job it already paid for.
 */
export async function generateStoredMedia(
  s: StageContext,
  stage: string,
  request: StoredMediaRequest,
  workDir: string,
): Promise<StoredMedia> {
  const media = requireService(s, "media");
  const storage = requireService(s, "storage");
  let result: MediaGenerationResult;
  try {
    result = await media.generate(s.ctx, mediaRequest(s, stage, request, workDir));
  } catch (err) {
    // The provider charged before it failed (e.g. the finished job's result could not be collected).
    if (err instanceof MediaChargedError) {
      throw new StageFailedAfterSpend(err, [mediaUsage(request, err.charge)]);
    }
    throw err;
  }
  // The provider call is paid from here on: whatever fails next still bills it.
  const usage = mediaUsage(request, {
    provider: result.provider,
    model: result.model,
    costCents: result.costCents,
    costSource: result.costSource ?? "unknown",
    ...(result.job ? { job: result.job } : {}),
  });
  try {
    const output = result.outputs[0];
    if (!output) {
      throw new StudixError("UNAVAILABLE", `${result.provider} returned no output for ${request.assetId}`, {
        details: { assetId: request.assetId, model: result.model },
      });
    }
    const ext = EXT_BY_MIME[output.mime] ?? extname(output.filePath);
    const { sha256, bytes } = await sha256File(output.filePath);
    const stored = await storage.put(
      s.ctx,
      `${request.keyPrefix}${ext}`,
      { filePath: output.filePath },
      { contentType: output.mime, sha256 },
    );
    const asset: AssetRef = {
      id: request.assetId,
      kind: assetKind(request.kind),
      storageKey: stored.key,
      sha256: stored.sha256,
      mime: output.mime,
      bytes,
      ...(output.width ? { width: output.width } : {}),
      ...(output.height ? { height: output.height } : {}),
      ...(output.durationMs ? { durationMs: Math.round(output.durationMs) } : {}),
      provenance: {
        source: "generated",
        provider: result.provider,
        model: result.model,
        prompt: request.prompt.slice(0, 4000),
      },
    };
    return { asset, filePath: output.filePath, usage };
  } catch (err) {
    throw new StageFailedAfterSpend(toStudixError(err), [usage]);
  }
}

/**
 * Run the work that follows paid generation (assembling and validating the IR). Its failure still bills
 * `usage`, because the provider calls it follows are already captured.
 */
export async function billedOnFailure<T>(usage: readonly StageUsage[], work: () => T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof StageFailedAfterSpend) throw err;
    throw new StageFailedAfterSpend(toStudixError(err), [...usage]);
  }
}
