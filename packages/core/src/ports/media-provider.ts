import { StudixError, type StudixErrorOptions } from "@studix/shared";
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
  /**
   * Where the provider remembers the upstream job of this request, so a retry on any worker resumes it
   * instead of paying again. Workflow stages pass their durable stage journal; without one the provider
   * uses its own (process-local) journal.
   */
  journal?: MediaJobJournal;
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

/** What the provider already charged for a call that then failed. */
export interface MediaCharge {
  provider: string;
  model: string;
  costCents: number;
  costSource: MediaCostSource;
  /** Present when the work ran as an upstream async job. */
  job?: ProviderJobRef;
}

/**
 * Thrown by a provider whose call failed after the upstream had already charged for it (the job finished
 * but its result could not be collected or trusted). `charge` is the money spent, so the caller records it
 * instead of losing it with the error.
 */
export class MediaChargedError extends StudixError {
  constructor(
    cause: StudixError,
    readonly charge: MediaCharge,
  ) {
    const options: StudixErrorOptions = {
      retryable: cause.retryable,
      cause,
      ...(cause.suggestedAction !== undefined ? { suggestedAction: cause.suggestedAction } : {}),
      ...(cause.details !== undefined ? { details: cause.details } : {}),
    };
    super(cause.code, cause.message, options);
    this.name = "MediaChargedError";
  }
}

/**
 * submitting: the request is about to reach (or may have reached) an upstream that cannot deduplicate it,
 * so no job id is known yet; submitted: paid and running upstream; completed: outputs collected;
 * failed: ended without outputs.
 */
export type MediaJobState = "submitting" | "submitted" | "completed" | "failed";

/** What a provider must remember about an upstream job to collect it later instead of paying again. */
export interface MediaJobRecord {
  idempotencyKey: string;
  kind: MediaKind;
  model: string;
  /** Absent while `state` is "submitting": the upstream has not reported an id yet. */
  job?: ProviderJobRef;
  /** Submission attempt for this idempotency key; a failed job is resubmitted as the next attempt. */
  attempt: number;
  state: MediaJobState;
  estimatedCostCents: number;
  /** Charge reported when the job completed. */
  receiptCents?: number;
  /**
   * The output as kept in tenant storage, written by the stored-media layer once the upload finished. A
   * provider whose calls have no upstream job to resume (synchronous audio) cannot find its output again
   * after the worker's scratch directory is gone; this lets a retry reuse the stored object instead of
   * paying for the same call twice.
   */
  storedOutput?: MediaJobStoredOutput;
  submittedAt: string;
  updatedAt: string;
}

/** An output already uploaded to tenant storage, bound to the request that produced it. */
export interface MediaJobStoredOutput {
  /** Digest of what the request asked for; a retry with a different request never matches. */
  fingerprint: string;
  storageKey: string;
  sha256: string;
  mime: string;
  bytes: number;
  durationMs?: number;
}

/**
 * Durable memory of upstream jobs, keyed by workspace and idempotency key. The record is written right
 * after submission, so a worker that dies while waiting leaves enough behind for the next attempt to
 * resume the same paid job. Implementations must scope reads and writes by `ctx.workspaceId`. `put` is an
 * unconditional overwrite: callers must serialize `generate` per idempotency key (the stage fencing does),
 * because the "submitting" intent is not a compare-and-set.
 */
export interface MediaJobJournal {
  get(ctx: TenantContext, idempotencyKey: string): Promise<MediaJobRecord | undefined>;
  put(ctx: TenantContext, record: MediaJobRecord): Promise<void>;
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
  /**
   * The "<vendor>:<model>" id a request would run on, the same id its result reports. Providers that route
   * a request without a model to a configured default expose this, so reused outputs follow that default.
   */
  resolveModel?(request: Pick<MediaGenerationRequest, "kind" | "model" | "params">): string;
  /** Providers with async upstream jobs expose this so a lost worker can collect a paid job. */
  resume?(ctx: TenantContext, request: MediaResumeRequest): Promise<MediaGenerationResult>;
}
