import type { TenantContext } from "../tenant.ts";

/**
 * Generation capabilities. `voice` is speech (TTS), `sfx` sound effects, `upscale` raises the resolution
 * of an image or video given in `params.image` / `params.video`. `audio` is generic audio for providers
 * that do not split it further.
 */
export const MEDIA_KINDS = ["image", "video", "audio", "voice", "music", "sfx", "upscale"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface MediaCapability {
  kind: MediaKind;
  /** Model ids this provider can run for the kind (configuration-driven). */
  models: string[];
  maxDurationMs?: number;
  /** Supported output MIME types. */
  outputMimes: string[];
}

export interface MediaGenerationRequest {
  kind: MediaKind;
  prompt: string;
  model?: string;
  /**
   * Provider-neutral parameters (aspectRatio, durationMs, voice, seed, ...). Input media for
   * image-to-video, lip-sync and upscale is `image`, `video` and `audio`: an absolute path inside
   * `workDir` or an https URL.
   */
  params?: Record<string, unknown>;
  /** Stable key so a retried stage does not pay twice. */
  idempotencyKey: string;
  /** Hard cap for this call; providers must refuse rather than exceed it. */
  maxCostCents: number;
  /** Directory where the provider writes outputs. */
  workDir: string;
  signal?: AbortSignal;
}

export interface GeneratedMedia {
  /** Absolute path of the generated file inside workDir. */
  filePath: string;
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

/** A job the upstream provider runs asynchronously; its id is enough to resume it without paying again. */
export interface ProviderJobRef {
  /** Upstream route that owns the job (e.g. "sume", "atlas"). */
  provider: string;
  id: string;
}

/**
 * Where `costCents` comes from: the provider's receipt, the pre-call estimate when no receipt reports a
 * price, or unknown (a resumed job whose estimate was not recorded).
 */
export type MediaCostSource = "receipt" | "estimate" | "unknown";

export interface MediaGenerationResult {
  outputs: GeneratedMedia[];
  provider: string;
  model: string;
  costCents: number;
  latencyMs: number;
  costSource?: MediaCostSource;
  /** Present when the work ran as an upstream async job. */
  job?: ProviderJobRef;
}

/** Resume an upstream job by id (e.g. after the worker that submitted it died). Never submits new work. */
export interface MediaResumeRequest {
  kind: MediaKind;
  job: ProviderJobRef;
  model?: string;
  /** Directory where the provider writes outputs. */
  workDir: string;
  /** Used as costCents when the provider reports no receipt for the job. */
  estimatedCostCents?: number;
  signal?: AbortSignal;
}

/** Image/video/audio generation backend (e.g. Multix). */
export interface MediaProvider {
  readonly id: string;
  capabilities(): Promise<MediaCapability[]>;
  estimateCostCents(
    request: Omit<MediaGenerationRequest, "workDir" | "signal" | "idempotencyKey">,
  ): Promise<number>;
  generate(ctx: TenantContext, request: MediaGenerationRequest): Promise<MediaGenerationResult>;
  /** Providers with async upstream jobs expose this so a lost worker can collect a paid job. */
  resume?(ctx: TenantContext, request: MediaResumeRequest): Promise<MediaGenerationResult>;
}
