import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MediaCapability,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaKind,
  MediaProvider,
  MediaResumeRequest,
  TenantContext,
} from "@studix/core";
import { type Clock, StudixError, systemClock } from "@studix/shared";
import {
  assertEstimateRequest,
  assertGenerationRequest,
  assertWithinBudget,
  throwIfAborted,
} from "./media-request-guards.ts";
import {
  encodeGradientAvi,
  encodeGradientPng,
  encodeToneWav,
  type Rgb,
} from "./placeholder-media-encoders.ts";

export const FAKE_PROVIDER_ID = "fake";
export const FAKE_MODEL = "fake-placeholder-v1";

const MIN_SIDE = 16;
const MAX_SIDE = 2048;
const DEFAULT_LONG_SIDE = 512;
/** Placeholder video is uncompressed, so it stays small. */
const VIDEO_LONG_SIDE = 160;
const VIDEO_FPS = 12;
const MIN_MEDIA_MS = 100;
const MAX_MEDIA_MS = 30_000;
const DEFAULT_MEDIA_MS = 2_000;
const AUDIO_KINDS: readonly MediaKind[] = ["audio", "voice", "music", "sfx"];
const FAKE_KINDS: readonly MediaKind[] = ["image", "video", ...AUDIO_KINDS, "upscale"];

type EstimateRequest = Omit<MediaGenerationRequest, "workDir" | "signal" | "idempotencyKey">;

export interface FakeMediaPricing {
  /** What estimateCostCents returns (default 0). */
  estimateCents?: (request: EstimateRequest) => number;
  /** What the "receipt" charges; undefined means no receipt, so the result falls back to the estimate. */
  chargeCents?: (request: MediaGenerationRequest) => number | undefined;
}

export interface FakeMediaProviderOptions {
  clock?: Clock;
  /** Simulated prices, for exercising billing policies; by default everything costs 0 with a receipt. */
  pricing?: FakeMediaPricing;
}

function intParam(
  params: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new StudixError("VALIDATION", `params.${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

/** Explicit width/height win; otherwise the aspect ratio sets the shape at the given long side. Both even. */
function frameSize(params: Record<string, unknown>, longSide: number): { width: number; height: number } {
  const width = intParam(params, "width", MIN_SIDE, MAX_SIDE);
  const height = intParam(params, "height", MIN_SIDE, MAX_SIDE);
  if (width !== undefined || height !== undefined) {
    if (width === undefined || height === undefined) {
      throw new StudixError("VALIDATION", "params.width and params.height must be given together");
    }
    return { width, height };
  }
  const ratio = params.aspectRatio;
  if (ratio === undefined) return { width: longSide, height: longSide };
  const match = typeof ratio === "string" ? /^(\d{1,2}):(\d{1,2})$/.exec(ratio) : null;
  const w = Number(match?.[1]);
  const h = Number(match?.[2]);
  if (!match || w === 0 || h === 0) {
    throw new StudixError("VALIDATION", 'params.aspectRatio must look like "16:9"');
  }
  const scale = longSide / Math.max(w, h);
  const even = (n: number) => Math.max(MIN_SIDE, Math.round((n * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
}

function color(digest: Buffer, offset: number): Rgb {
  return [digest[offset]!, digest[offset + 1]!, digest[offset + 2]!];
}

type Shape = { type: "image" | "video" | "audio"; width?: number; height?: number; durationMs?: number };

/** What a request renders as: upscale scales the input's placeholder size by params.scale. */
function shapeOf(request: MediaGenerationRequest): { shape: Shape; input: string | null } {
  const params = request.params ?? {};
  if (AUDIO_KINDS.includes(request.kind)) {
    const durationMs = intParam(params, "durationMs", MIN_MEDIA_MS, MAX_MEDIA_MS) ?? DEFAULT_MEDIA_MS;
    return { shape: { type: "audio", durationMs }, input: null };
  }
  if (request.kind === "upscale") {
    const image = params.image;
    const video = params.video;
    const input = image ?? video;
    if ((image === undefined) === (video === undefined) || typeof input !== "string" || input === "") {
      throw new StudixError("VALIDATION", "upscale needs exactly one of params.image or params.video");
    }
    const scale = intParam(params, "scale", 1, 4) ?? 2;
    const isVideo = video !== undefined;
    const base = frameSize(params, (isVideo ? VIDEO_LONG_SIDE : DEFAULT_LONG_SIDE) / 2);
    const width = Math.min(MAX_SIDE, base.width * scale);
    const height = Math.min(MAX_SIDE, base.height * scale);
    return isVideo
      ? { shape: { type: "video", width, height, durationMs: DEFAULT_MEDIA_MS }, input }
      : { shape: { type: "image", width, height }, input };
  }
  if (request.kind === "video") {
    const size = frameSize(params, VIDEO_LONG_SIDE);
    const durationMs = intParam(params, "durationMs", MIN_MEDIA_MS, MAX_MEDIA_MS) ?? DEFAULT_MEDIA_MS;
    return { shape: { type: "video", ...size, durationMs }, input: null };
  }
  return { shape: { type: "image", ...frameSize(params, DEFAULT_LONG_SIDE) }, input: null };
}

/**
 * Deterministic, offline MediaProvider for tests, demos and CI. It covers every kind the Multix provider
 * serves: images are gradient PNGs, video an uncompressed gradient AVI, audio a sine tone WAV, and upscale
 * a larger placeholder of the input's type. Output bytes derive only from the request, so the same request
 * always yields byte-identical files. It never touches the network. Each result carries a fake job id that
 * resume() collects again, as a real async provider would after a worker restart.
 */
export class FakeMediaProvider implements MediaProvider {
  readonly id = FAKE_PROVIDER_ID;
  private readonly clock: Clock;
  private readonly pricing: FakeMediaPricing;
  private readonly jobs = new Map<string, { workspaceId: string; result: MediaGenerationResult }>();

  constructor(options: FakeMediaProviderOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.pricing = options.pricing ?? {};
  }

  async capabilities(): Promise<MediaCapability[]> {
    return FAKE_KINDS.map((kind): MediaCapability => {
      if (kind === "image") return { kind, models: [FAKE_MODEL], outputMimes: ["image/png"] };
      if (kind === "video") {
        return { kind, models: [FAKE_MODEL], maxDurationMs: MAX_MEDIA_MS, outputMimes: ["video/x-msvideo"] };
      }
      if (kind === "upscale")
        return { kind, models: [FAKE_MODEL], outputMimes: ["image/png", "video/x-msvideo"] };
      return { kind, models: [FAKE_MODEL], maxDurationMs: MAX_MEDIA_MS, outputMimes: ["audio/wav"] };
    });
  }

  async estimateCostCents(request: EstimateRequest): Promise<number> {
    assertEstimateRequest(request);
    this.assertSupported(request.kind, request.model);
    return this.pricing.estimateCents?.(request) ?? 0;
  }

  async generate(ctx: TenantContext, request: MediaGenerationRequest): Promise<MediaGenerationResult> {
    const started = this.clock.now().getTime();
    assertGenerationRequest(request);
    this.assertSupported(request.kind, request.model);
    const estimate = this.pricing.estimateCents?.(request) ?? 0;
    assertWithinBudget(estimate, request.maxCostCents, this.id);
    throwIfAborted(request.signal);

    const params = request.params ?? {};
    const seed = params.seed ?? null;
    if (seed !== null && typeof seed !== "string" && typeof seed !== "number") {
      throw new StudixError("VALIDATION", "params.seed must be a string or number");
    }
    const { shape, input } = shapeOf(request);
    const digest = createHash("sha256")
      .update(JSON.stringify([request.kind, FAKE_MODEL, request.prompt, seed, shape, input]))
      .digest();
    const from = color(digest, 0);
    const to = color(digest, 3);
    const [bytes, ext, mime] =
      shape.type === "image"
        ? [encodeGradientPng(shape.width!, shape.height!, from, to), "png", "image/png"]
        : shape.type === "video"
          ? [
              encodeGradientAvi(
                shape.width!,
                shape.height!,
                Math.max(1, Math.round((shape.durationMs! * VIDEO_FPS) / 1000)),
                VIDEO_FPS,
                from,
                to,
              ),
              "avi",
              "video/x-msvideo",
            ]
          : [encodeToneWav(shape.durationMs!, 220 + (digest.readUInt16BE(6) % 440)), "wav", "audio/wav"];
    const hex = digest.toString("hex").slice(0, 16);
    const filePath = join(request.workDir, `${this.id}-${request.kind}-${hex}.${ext}`);
    await this.writeAtomic(filePath, bytes);
    throwIfAborted(request.signal);

    const charge = this.pricing.chargeCents?.(request);
    const result: MediaGenerationResult = {
      outputs: [
        {
          filePath,
          mime,
          ...(shape.width !== undefined ? { width: shape.width, height: shape.height } : {}),
          ...(shape.durationMs !== undefined ? { durationMs: shape.durationMs } : {}),
        },
      ],
      provider: this.id,
      model: FAKE_MODEL,
      costCents: charge ?? estimate,
      costSource: charge === undefined && this.pricing.chargeCents ? "estimate" : "receipt",
      latencyMs: Math.max(0, this.clock.now().getTime() - started),
      job: { provider: this.id, id: `fake_${hex}` },
    };
    this.jobs.set(result.job!.id, { workspaceId: ctx.workspaceId, result });
    return structuredClone(result);
  }

  /** Collect a job generate() already ran; unknown ids (or another workspace's) are NOT_FOUND. */
  async resume(ctx: TenantContext, request: MediaResumeRequest): Promise<MediaGenerationResult> {
    throwIfAborted(request.signal);
    const job = request.job.provider === this.id ? this.jobs.get(request.job.id) : undefined;
    if (!job || job.workspaceId !== ctx.workspaceId || job.result.outputs[0] === undefined) {
      throw new StudixError("NOT_FOUND", `Unknown fake job "${request.job.id}"`);
    }
    if (!(await stat(job.result.outputs[0].filePath).catch(() => null))) {
      throw new StudixError("NOT_FOUND", `The outputs of fake job "${request.job.id}" are gone`);
    }
    return { ...structuredClone(job.result), latencyMs: 0 };
  }

  private assertSupported(kind: MediaKind, model: string | undefined): void {
    if (!FAKE_KINDS.includes(kind)) {
      throw new StudixError("UNAVAILABLE", `The fake provider does not generate ${kind}`, {
        retryable: false,
      });
    }
    if (model !== undefined && model !== FAKE_MODEL) {
      throw new StudixError("VALIDATION", `The fake provider only runs model "${FAKE_MODEL}"`);
    }
  }

  /** Write then rename so a concurrent reader never sees a partial file. */
  private async writeAtomic(filePath: string, bytes: Buffer): Promise<void> {
    const tmp = `${filePath}.part-${randomUUID()}`;
    try {
      await mkdir(join(filePath, ".."), { recursive: true });
      await writeFile(tmp, bytes);
      await rename(tmp, filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      // The path is content-addressed, so concurrent identical requests race for one target; on Windows the
      // losing rename fails (EPERM) while the winner holds it. Same bytes already there is the same result.
      const existing = await readFile(filePath).catch(() => undefined);
      if (existing?.equals(bytes)) return;
      throw new StudixError("INTERNAL", "Could not write placeholder media", { cause: err });
    }
  }
}
