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

/** A layout or markup problem found before rendering. */
export interface RenderIssue {
  sceneId: string;
  shotId?: string;
  code: "lint" | "overflow" | "caption-overlap" | "text-clipped" | "blank";
  message: string;
}

export interface RenderInspection {
  issues: RenderIssue[];
  /** PNG snapshots of inspected html shots (absolute paths under workDir). */
  snapshots: { sceneId: string; shotId: string; filePath: string; atMs: number }[];
}

export interface RenderInspectOptions {
  spec: RenderSpec;
  /** Scratch directory owned by this inspection; snapshots are written under it and kept. */
  workDir: string;
  /** Map of IR asset id -> local file path, already downloaded and hash-verified by the caller. */
  assetFiles?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

/** Turns a validated VideoIR into a local media file. Storage upload is the caller's job. */
export interface RendererAdapter {
  readonly id: string;
  supports(ir: VideoIR, spec: RenderSpec): RendererSupport;
  render(ir: VideoIR, options: RenderOptions): Promise<RenderOutput>;
  /** Pre-render visual QA of custom markup (html shots): lint findings and measured layout problems. */
  inspect?(ir: VideoIR, options: RenderInspectOptions): Promise<RenderInspection>;
}
