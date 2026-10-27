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
  onProgress?: (progress: RenderProgress) => void;
}

export interface RenderOutput {
  /** Absolute path of the produced media file inside workDir. */
  filePath: string;
  mime: string;
  probe: MediaProbe;
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
}
