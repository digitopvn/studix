import type { TenantContext } from "../tenant.ts";

export const MEDIA_KINDS = ["image", "video", "audio", "voice", "music"] as const;
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
  /** Provider-neutral parameters (aspectRatio, durationMs, voice, seed, ...). */
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

export interface MediaGenerationResult {
  outputs: GeneratedMedia[];
  provider: string;
  model: string;
  costCents: number;
  latencyMs: number;
}

/** Image/video/audio generation backend (e.g. Multix). */
export interface MediaProvider {
  readonly id: string;
  capabilities(): Promise<MediaCapability[]>;
  estimateCostCents(
    request: Omit<MediaGenerationRequest, "workDir" | "signal" | "idempotencyKey">,
  ): Promise<number>;
  generate(ctx: TenantContext, request: MediaGenerationRequest): Promise<MediaGenerationResult>;
}
