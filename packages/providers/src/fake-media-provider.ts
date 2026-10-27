import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MediaCapability,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaKind,
  MediaProvider,
  TenantContext,
} from "@studix/core";
import { type Clock, StudixError, systemClock } from "@studix/shared";
import {
  assertEstimateRequest,
  assertGenerationRequest,
  assertWithinBudget,
  throwIfAborted,
} from "./media-request-guards.ts";
import { encodeGradientPng, encodeToneWav, type Rgb } from "./placeholder-media-encoders.ts";

export const FAKE_PROVIDER_ID = "fake";
export const FAKE_MODEL = "fake-placeholder-v1";

const MIN_SIDE = 16;
const MAX_SIDE = 2048;
const DEFAULT_LONG_SIDE = 512;
const MIN_AUDIO_MS = 100;
const MAX_AUDIO_MS = 30_000;
const DEFAULT_AUDIO_MS = 2_000;
const AUDIO_KINDS: readonly MediaKind[] = ["audio", "voice", "music"];

export interface FakeMediaProviderOptions {
  clock?: Clock;
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

/** Explicit width/height win; otherwise the aspect ratio's long side is 512px. Both sides stay even. */
function imageSize(params: Record<string, unknown>): { width: number; height: number } {
  const width = intParam(params, "width", MIN_SIDE, MAX_SIDE);
  const height = intParam(params, "height", MIN_SIDE, MAX_SIDE);
  if (width !== undefined || height !== undefined) {
    if (width === undefined || height === undefined) {
      throw new StudixError("VALIDATION", "params.width and params.height must be given together");
    }
    return { width, height };
  }
  const ratio = params.aspectRatio;
  if (ratio === undefined) return { width: DEFAULT_LONG_SIDE, height: DEFAULT_LONG_SIDE };
  const match = typeof ratio === "string" ? /^(\d{1,2}):(\d{1,2})$/.exec(ratio) : null;
  const w = Number(match?.[1]);
  const h = Number(match?.[2]);
  if (!match || w === 0 || h === 0) {
    throw new StudixError("VALIDATION", 'params.aspectRatio must look like "16:9"');
  }
  const scale = DEFAULT_LONG_SIDE / Math.max(w, h);
  const even = (n: number) => Math.max(MIN_SIDE, Math.round((n * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
}

function color(digest: Buffer, offset: number): Rgb {
  return [digest[offset]!, digest[offset + 1]!, digest[offset + 2]!];
}

/**
 * Deterministic, offline MediaProvider for tests, demos and CI. Images are gradient PNGs and audio is a
 * sine tone WAV, both derived only from the request (kind, prompt, model, seed, size), so the same request
 * always yields byte-identical files. It never touches the network and always costs 0 cents.
 * It does not claim video: placeholders must not stand in for modalities nothing can render.
 */
export class FakeMediaProvider implements MediaProvider {
  readonly id = FAKE_PROVIDER_ID;
  private readonly clock: Clock;

  constructor(options: FakeMediaProviderOptions = {}) {
    this.clock = options.clock ?? systemClock;
  }

  async capabilities(): Promise<MediaCapability[]> {
    return [
      { kind: "image", models: [FAKE_MODEL], outputMimes: ["image/png"] },
      ...AUDIO_KINDS.map((kind) => ({
        kind,
        models: [FAKE_MODEL],
        maxDurationMs: MAX_AUDIO_MS,
        outputMimes: ["audio/wav"],
      })),
    ];
  }

  async estimateCostCents(
    request: Omit<MediaGenerationRequest, "workDir" | "signal" | "idempotencyKey">,
  ): Promise<number> {
    assertEstimateRequest(request);
    this.assertSupported(request.kind, request.model);
    return 0;
  }

  async generate(_ctx: TenantContext, request: MediaGenerationRequest): Promise<MediaGenerationResult> {
    const started = this.clock.now().getTime();
    assertGenerationRequest(request);
    this.assertSupported(request.kind, request.model);
    assertWithinBudget(0, request.maxCostCents, this.id);
    throwIfAborted(request.signal);

    const params = request.params ?? {};
    const seed = params.seed ?? null;
    if (seed !== null && typeof seed !== "string" && typeof seed !== "number") {
      throw new StudixError("VALIDATION", "params.seed must be a string or number");
    }
    const isImage = request.kind === "image";
    const size = isImage ? imageSize(params) : undefined;
    const durationMs = isImage
      ? undefined
      : (intParam(params, "durationMs", MIN_AUDIO_MS, MAX_AUDIO_MS) ?? DEFAULT_AUDIO_MS);
    const digest = createHash("sha256")
      .update(
        JSON.stringify([request.kind, FAKE_MODEL, request.prompt, seed, size ?? null, durationMs ?? null]),
      )
      .digest();

    const bytes = size
      ? encodeGradientPng(size.width, size.height, color(digest, 0), color(digest, 3))
      : encodeToneWav(durationMs!, 220 + (digest.readUInt16BE(6) % 440));
    const filePath = join(
      request.workDir,
      `${this.id}-${request.kind}-${digest.toString("hex").slice(0, 16)}.${isImage ? "png" : "wav"}`,
    );
    await this.writeAtomic(filePath, bytes);
    throwIfAborted(request.signal);

    return {
      outputs: [
        size
          ? { filePath, mime: "image/png", width: size.width, height: size.height }
          : { filePath, mime: "audio/wav", durationMs },
      ],
      provider: this.id,
      model: FAKE_MODEL,
      costCents: 0,
      latencyMs: Math.max(0, this.clock.now().getTime() - started),
    };
  }

  private assertSupported(kind: MediaKind, model: string | undefined): void {
    if (kind !== "image" && !AUDIO_KINDS.includes(kind)) {
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
      throw new StudixError("INTERNAL", "Could not write placeholder media", { cause: err });
    }
  }
}
