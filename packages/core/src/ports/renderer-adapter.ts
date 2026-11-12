import type { RenderSpec, VideoIR } from "@studix/video-ir";
import type { MediaProbe } from "../entities/job.ts";

export interface RenderProgress {
  /** 0..1 */
  progress: number;
  phase: string;
}

export interface RenderOptions {
  spec: RenderSpec;
  /** Scratch directory owned by this render; the adapter writes its output here. */
  workDir: string;
  /** Map of IR asset id -> local file path, already downloaded and hash-verified by the caller. */
  assetFiles: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** The job's deadline: the adapter may stop early, with TIMEOUT, once it projects to finish after it. */
  deadlineAt?: Date;
  onProgress?: (progress: RenderProgress) => void;
}

/** Loudness of a delivered file's audio, measured after encoding. */
export interface DeliveryLoudness {
  integratedLufs: number;
  truePeakDbtp: number;
}

/** One delivered file. `master` is the same file as RenderOutput.filePath. */
export interface RenderDelivery {
  kind: "master" | "preview" | "phone";
  filePath: string;
  mime: string;
  probe: MediaProbe;
  /** Absent when the render has no sound. */
  loudness?: DeliveryLoudness;
}

export interface RenderOutput {
  /** Absolute path of the produced media file inside workDir (the master delivery). */
  filePath: string;
  mime: string;
  probe: MediaProbe;
  /** Every delivered file, master first, when the adapter produces more than one. */
  deliveries?: RenderDelivery[];
}

export interface RendererSupport {
  supported: boolean;
  /** Why the IR cannot be rendered by this adapter (unsupported shot types, codecs, ...). */
  reasons: string[];
}

/** Turns a validated VideoIR into a local media file. Storage upload is the caller's job. */
export interface RendererAdapter {
  readonly id: string;
  supports(ir: VideoIR, spec: RenderSpec): RendererSupport;
  render(ir: VideoIR, options: RenderOptions): Promise<RenderOutput>;
  /**
   * Captures a few stills for a visual review, far cheaper than `render`: the picture only (no sound, no
   * deliveries), on a coarse frame grid, at the preview size. Optional: an adapter without it has no review.
   */
  stills?(ir: VideoIR, options: StillsOptions): Promise<StillsOutput>;
}

/** Where to take each still: one window per still, in film time (ms). */
export interface StillsOptions extends Omit<RenderOptions, "spec"> {
  windows: readonly { fromMs: number; toMs: number }[];
}

export interface StillsOutput {
  /** A silent video holding the stills (and the coarse frames around them). */
  filePath: string;
  /** Per window, where to seek in `filePath` so the first frame decoded there is its still. */
  seekMs: number[];
  /** Frames captured, for logs and tests. */
  frames: number;
}
