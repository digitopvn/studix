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
import { type AssetMediaKind, type AssetRef, contentDigest, type VideoIR } from "@studix/video-ir";
import {
  type ReusableMedia,
  requireService,
  type StageContext,
  StageFailedAfterSpend,
  type StageUsage,
  sha256File,
  stageMediaDir,
} from "@studix/workflow";

/** One media asset a pack stage generates and keeps in tenant storage. */
export interface StoredMediaRequest {
  /** IR asset id of the result; also names the upstream idempotency key, so keep it stable per job. */
  assetId: string;
  kind: MediaKind;
  /** `<vendor>:<model>` to run on instead of the provider's default or language route for this kind. */
  model?: string;
  prompt: string;
  params?: Record<string, unknown>;
  /** Storage key prefix; the file extension is appended. */
  keyPrefix: string;
  /** Upper bound for this one call (providers refuse rather than exceed it). */
  maxCostCents: number;
  /**
   * Reuse the stored output of an earlier identical request of the tenant instead of paying again. Only for
   * requests whose output depends on nothing but the provider, kind, model, prompt, parameters and the
   * input files named here.
   */
  reuse?: {
    /**
     * Parameters that carry a local input file, with the sha256 of that file's content: the key holds the
     * digest, never the path, so a file parameter left out here (its path differs per job) never matches.
     */
    inputs?: Record<string, string>;
    /**
     * Names a check the stored output passed, folded into the key: outputs stored without that check (by an
     * earlier job or worker) are never served to a request that requires it.
     */
    scope?: string;
  };
  /**
   * Which regeneration of the asset this is (omitted for the first). It gives the provider call its own
   * idempotency key and usage line, so a second call is made and billed instead of resuming the first.
   */
  retry?: number;
}

/** A generated file the caller's check turned down: paid for, but neither stored nor cached. */
export interface RejectedMedia {
  rejected: true;
  usage: StageUsage;
  filePath: string;
}

export interface StoredMedia {
  asset: AssetRef;
  /** The usage line of the call, tied to the upstream job so a resumed stage never bills it twice. */
  usage: StageUsage;
  /** Local copy in the stage work directory; undefined when an earlier job's stored output was reused. */
  filePath?: string;
  /** Set when an earlier job's stored output was reused: nothing was generated or charged. */
  reusedFrom?: { jobId?: string };
}

/**
 * Reuse for a request whose file parameters carry the IR assets named in `files` (parameter -> asset id),
 * keyed by their content. When one of them has no recorded digest the request gets no reuse and is paid for.
 */
export function reuseOnAssets(ir: VideoIR, files: Record<string, string>): Pick<StoredMediaRequest, "reuse"> {
  const inputs: Record<string, string> = {};
  for (const [param, assetId] of Object.entries(files)) {
    const sha256 = ir.assets.find((a) => a.id === assetId)?.sha256;
    if (!sha256) return {};
    inputs[param] = sha256;
  }
  return { reuse: { inputs } };
}

type ReuseRequest = Pick<StoredMediaRequest, "kind" | "model" | "prompt" | "params" | "reuse">;

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

const retrySuffix = (request: Pick<StoredMediaRequest, "retry">, sep: string): string =>
  request.retry ? `${sep}${request.retry}` : "";

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
    ...(request.model ? { model: request.model } : {}),
    prompt: request.prompt,
    ...(request.params ? { params: request.params } : {}),
    // Stable across attempts and workers: the stage journal resumes the upstream job under this key.
    idempotencyKey: `${s.job.id}:${stage}:${request.assetId}${retrySuffix(request, ":r")}`,
    maxCostCents: request.maxCostCents,
    workDir,
    signal: s.signal,
    journal: s.mediaJournal,
  };
}

/**
 * Content key of a reusable request: what produces the output and nothing that names the job, stage or
 * asset. The model is the one the provider would run (its default when the request names none), so is the
 * voice a speech route adds, and input files count by their digest. Undefined when the request does not opt
 * into reuse.
 */
export function mediaOutputKey(s: StageContext, request: ReuseRequest): string | undefined {
  if (!request.reuse) return undefined;
  const media = requireService(s, "media");
  const inputs = request.reuse.inputs ?? {};
  const params = Object.fromEntries(Object.entries(request.params ?? {}).filter(([k]) => !(k in inputs)));
  const routed = {
    kind: request.kind,
    ...(request.model ? { model: request.model } : {}),
    ...(request.params ? { params: request.params } : {}),
  };
  const model = media.resolveModel?.(routed) ?? request.model ?? null;
  // A voice the provider's routing adds is part of the output; one the request names is already in params.
  const voice = media.resolveVoice?.(routed);
  const work = {
    provider: media.id,
    kind: request.kind,
    model,
    ...(voice !== undefined && voice !== request.params?.voice ? { voice } : {}),
    prompt: request.prompt,
    params,
    inputs,
    ...(request.reuse.scope ? { scope: request.reuse.scope } : {}),
  };
  return `media@1:${contentDigest(work)}`;
}

/**
 * The stored output of an earlier identical request, when the tenant has one whose object is still in
 * storage with the recorded digest. Anything else is a miss, so a stage pays again rather than reuse a file
 * it cannot vouch for.
 */
export async function findReusableMedia(
  s: StageContext,
  request: ReuseRequest,
): Promise<ReusableMedia | undefined> {
  const key = mediaOutputKey(s, request);
  if (key === undefined || !s.mediaOutputs) return undefined;
  const hit = await s.mediaOutputs.get(key);
  if (!hit?.asset.storageKey || hit.asset.kind !== assetKind(request.kind)) return undefined;
  const stored = await requireService(s, "storage").head(s.ctx, hit.asset.storageKey);
  if (!stored || stored.sha256 !== hit.asset.sha256) return undefined;
  return hit;
}

/**
 * Sum of the provider's estimates for `requests`, in cents (the budget check before a paid stage). A request
 * a reusable stored output serves costs nothing.
 */
export async function estimateMediaCents(
  s: StageContext,
  requests: readonly Pick<
    StoredMediaRequest,
    "kind" | "model" | "prompt" | "params" | "maxCostCents" | "reuse"
  >[],
): Promise<number> {
  const media = requireService(s, "media");
  let total = 0;
  for (const r of requests) {
    if (await findReusableMedia(s, r)) continue;
    total += await media.estimateCostCents({
      kind: r.kind,
      ...(r.model ? { model: r.model } : {}),
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
    item: `media-${request.assetId}${retrySuffix(request, "-r")}`,
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

/** The asset and zero-cost usage line of a request an earlier job's stored output serves. */
function reusedMedia(request: StoredMediaRequest, hit: ReusableMedia): StoredMedia {
  const { provider, model } = hit.asset.provenance ?? {};
  return {
    asset: { ...hit.asset, id: request.assetId },
    usage: {
      item: `media-${request.assetId}`,
      kind: USAGE_KINDS.mediaGeneration,
      quantity: 0,
      unit: request.kind,
      costCents: 0,
      metadata: {
        mediaKind: request.kind,
        assetId: request.assetId,
        reused: true,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(hit.jobId ? { reusedFromJob: hit.jobId } : {}),
      },
    },
    reusedFrom: hit.jobId ? { jobId: hit.jobId } : {},
  };
}

/**
 * Generate one asset with the worker's media provider, then store it in tenant storage and describe it as
 * an IR asset with provenance. The request carries the stage's durable journal, so a retry on any worker
 * collects the job it already paid for. A request that opts into reuse is first looked up among the stored
 * outputs of identical earlier requests, and records its own output for the next one.
 */
export function generateStoredMedia(
  s: StageContext,
  stage: string,
  request: StoredMediaRequest,
): Promise<StoredMedia>;
/**
 * With `accept`, the generated file is checked before it is stored or cached: a file it turns down comes back
 * as `RejectedMedia` (still billed), so a bad output never reaches storage or the tenant's reuse cache. A
 * reused output was accepted when it was stored, so it is not checked again.
 */
export function generateStoredMedia(
  s: StageContext,
  stage: string,
  request: StoredMediaRequest,
  accept: (filePath: string) => Promise<boolean>,
): Promise<StoredMedia | RejectedMedia>;
export async function generateStoredMedia(
  s: StageContext,
  stage: string,
  request: StoredMediaRequest,
  accept?: (filePath: string) => Promise<boolean>,
): Promise<StoredMedia | RejectedMedia> {
  const media = requireService(s, "media");
  const storage = requireService(s, "storage");
  const reused = await findReusableMedia(s, request);
  if (reused) return reusedMedia(request, reused);
  const reuseKey = mediaOutputKey(s, request);
  // The provider writes to the job-scoped media directory, not the attempt scratch directory.
  const mediaDir = await stageMediaDir(s, stage);
  let result: MediaGenerationResult;
  try {
    result = await media.generate(s.ctx, mediaRequest(s, stage, request, mediaDir));
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
    if (accept && !(await accept(output.filePath)))
      return { rejected: true, usage, filePath: output.filePath };
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
    if (reuseKey !== undefined) await s.mediaOutputs?.put(reuseKey, asset);
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
