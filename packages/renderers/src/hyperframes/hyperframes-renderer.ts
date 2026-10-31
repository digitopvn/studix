import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  RenderDelivery,
  RendererAdapter,
  RendererSupport,
  RenderOptions,
  RenderOutput,
} from "@studix/core";
import { createLogger, type Logger, StudixError, toStudixError } from "@studix/shared";
import { type RenderSpec, renderDimensions, type VideoIR } from "@studix/video-ir";
import { type AudioSourceInfo, mixAudio, planAudioClips } from "../ffmpeg/audio-mix.ts";
import { type ExtraDelivery, type FinishedFile, finishDeliveries } from "../ffmpeg/ffmpeg-finish.ts";
import { FfmpegProbe, probeMismatches } from "../ffmpeg/ffmpeg-probe.ts";
import type { GradeLook } from "../ffmpeg/grade.ts";
import { normalizeLoudness } from "../ffmpeg/loudness.ts";
import { buildComposition, writeComposition } from "./compile-composition.ts";
import { hyperframesSupport } from "./hyperframes-support.ts";
import { renderWithProducer } from "./producer-render.ts";

export interface HyperFramesRendererOptions {
  /** ffmpeg binary (config.FFMPEG_PATH). */
  ffmpegPath?: string;
  /** ffprobe binary (config.FFPROBE_PATH). */
  ffprobePath?: string;
  /** Parallel capture workers; defaults to the producer's automatic sizing. */
  workers?: number;
  logger?: Logger;
  /** Finish defaults; a render may override them with HyperFramesRenderOptions.finish. */
  finish?: FinishSpec;
}

/**
 * Finish choices the IR and RenderSpec do not carry yet (local adapter type until the contract grows
 * `grade` and `deliveries`).
 */
export interface FinishSpec {
  /** Colour look applied to the master; omitted means the captured picture is stream-copied. */
  grade?: GradeLook;
  /**
   * Extra deliveries besides the master. Defaults to preview + phone for the `final` preset and none for
   * `preview`; the phone copy is only made for 9:16 IR.
   */
  deliveries?: readonly ExtraDelivery[];
}

export interface HyperFramesRenderOptions extends RenderOptions {
  finish?: FinishSpec;
}

/** Progress budget per phase; capture dominates wall time. */
const PHASES = { compile: 0.05, capture: 0.85, mix: 0.88, finish: 0.97 } as const;

/**
 * RendererAdapter over HyperFrames: compiles the IR into an HTML/GSAP composition at the render size,
 * captures it with headless Chromium, packages the MP4 with FFmpeg and verifies it with ffprobe.
 * Requires chrome-headless-shell and FFmpeg on the host (the worker image ships both).
 */
export class HyperFramesRenderer implements RendererAdapter {
  readonly id = "hyperframes";
  private readonly probe: FfmpegProbe;
  private readonly log: Logger;

  constructor(private readonly options: HyperFramesRendererOptions = {}) {
    this.probe = new FfmpegProbe({ ffprobePath: options.ffprobePath });
    this.log = options.logger ?? createLogger({ component: "hyperframes-renderer" }, { level: "warn" });
  }

  supports(ir: VideoIR, spec: RenderSpec): RendererSupport {
    return hyperframesSupport(ir, spec);
  }

  async render(ir: VideoIR, options: HyperFramesRenderOptions): Promise<RenderOutput> {
    const { spec, workDir, signal } = options;
    const support = this.supports(ir, spec);
    if (!support.supported) {
      throw new StudixError("VALIDATION", `IR cannot be rendered by HyperFrames: ${support.reasons[0]}`, {
        details: { reasons: support.reasons },
        retryable: false,
        suggestedAction: "Remove or replace the unsupported elements, then retry.",
      });
    }
    if (!isAbsolute(workDir))
      throw new StudixError("VALIDATION", "RenderOptions.workDir must be an absolute path");
    const report = (progress: number, phase: string) => {
      try {
        options.onProgress?.({ progress: Math.min(1, Math.max(0, progress)), phase });
      } catch (err) {
        this.log.warn("render progress callback threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    const cancelled = () => new StudixError("CANCELLED", "Render cancelled");
    const finish = { ...this.options.finish, ...options.finish };

    const { width, height } = renderDimensions(ir.format, spec);
    const fps = spec.fps ?? ir.format.fps;
    const projectDir = join(workDir, "composition");
    const rawPath = join(workDir, "capture.raw.mp4");
    const mixPath = join(workDir, "mix.raw.wav");
    const normalizedMixPath = join(workDir, "mix.norm.wav");

    try {
      if (signal?.aborted) throw cancelled();
      report(0, "compile");
      await mkdir(workDir, { recursive: true });
      await rm(projectDir, { recursive: true, force: true });
      const build = buildComposition(ir, { width, height, assetFiles: options.assetFiles });
      for (const warning of build.warnings) this.log.warn(warning);
      await writeComposition(build, projectDir);
      report(PHASES.compile, "capture");

      if (signal?.aborted) throw cancelled();
      const { warnings } = await renderWithProducer({
        projectDir,
        outputPath: rawPath,
        fps,
        quality: spec.preset === "final" ? "high" : "draft",
        crf: spec.crf,
        workers: this.options.workers,
        logger: this.log,
        signal,
        onProgress: (p, stage) => report(PHASES.compile + p * (PHASES.capture - PHASES.compile), stage),
      });
      for (const warning of warnings) this.log.warn("hyperframes render warning", { warning });

      if (signal?.aborted) throw cancelled();
      report(PHASES.capture, "mix");
      const audio = await this.mix(ir, options.assetFiles, mixPath, normalizedMixPath, signal);

      if (signal?.aborted) throw cancelled();
      report(PHASES.mix, "finish");
      const files = await finishDeliveries(
        {
          video: rawPath,
          audio,
          outDir: workDir,
          name: `render-${spec.preset}`,
          durationMs: ir.format.durationMs,
          aspectRatio: ir.format.aspectRatio,
          crf: spec.crf,
          grade: finish.grade,
          extras: finish.deliveries ?? (spec.preset === "final" ? ["preview", "phone"] : []),
        },
        { ffmpegPath: this.options.ffmpegPath, signal },
      );

      report(PHASES.finish, "verify");
      const deliveries = await this.verify(files, ir, spec, { width, height, fps }, signal);
      const master = deliveries[0]!;
      report(1, "complete");
      return { filePath: master.filePath, mime: master.mime, probe: master.probe, deliveries };
    } catch (err) {
      if (signal?.aborted) throw err instanceof StudixError && err.code === "CANCELLED" ? err : cancelled();
      throw toStudixError(err);
    } finally {
      await Promise.all(
        [rawPath, mixPath, normalizedMixPath].map((p) => rm(p, { force: true }).catch(() => undefined)),
      );
    }
  }

  /**
   * Mixes IR audio tracks and unmuted video-shot sound, then normalises it with two-pass loudnorm.
   * Returns the normalised WAV, or undefined when the render has no sound.
   */
  private async mix(
    ir: VideoIR,
    assetFiles: Readonly<Record<string, string>>,
    mixPath: string,
    normalizedPath: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const wanted = new Set<string>();
    for (const track of ir.audio ?? []) wanted.add(track.assetId);
    for (const scene of ir.scenes)
      for (const shot of scene.shots) if (shot.type === "video" && !shot.muted) wanted.add(shot.assetId);
    const sources = new Map<string, AudioSourceInfo>();
    for (const assetId of wanted) {
      const file = assetFiles[assetId];
      if (!file) {
        throw new StudixError("VALIDATION", `Audio source "${assetId}" has no local file`, {
          details: { assetId },
          suggestedAction: "Download the asset and pass it in RenderOptions.assetFiles.",
        });
      }
      if (!sources.has(file)) sources.set(file, await this.probe.audioSource(file, signal));
    }
    const clips = planAudioClips(ir, assetFiles, sources);
    if (clips.length === 0) return undefined;
    const ffmpeg = { ffmpegPath: this.options.ffmpegPath, signal };
    await mixAudio(clips, ir.format.durationMs, mixPath, ffmpeg);
    const measured = await normalizeLoudness(mixPath, normalizedPath, ffmpeg);
    if (!measured) {
      this.log.warn("audio mix is silent; delivering without loudness normalisation");
      return undefined;
    }
    this.log.debug("audio mix normalised", { clips: clips.length, measured });
    return normalizedPath;
  }

  /** Probes every delivery; the master must match the render size, every copy the duration and codec. */
  private async verify(
    files: readonly FinishedFile[],
    ir: VideoIR,
    spec: RenderSpec,
    frame: { width: number; height: number; fps: number },
    signal?: AbortSignal,
  ): Promise<RenderDelivery[]> {
    const deliveries: RenderDelivery[] = [];
    for (const file of files) {
      const probe = await this.probe.probe(file.filePath, signal);
      const master = file.kind === "master";
      const mismatches = probeMismatches(probe, {
        width: master ? frame.width : probe.width,
        height: master ? frame.height : probe.height,
        durationMs: ir.format.durationMs,
        videoCodec: spec.videoCodec,
        durationToleranceMs: Math.ceil(1000 / frame.fps) + 100,
      });
      if (mismatches.length > 0) {
        throw new StudixError(
          "INTERNAL",
          `Rendered ${file.kind} does not match the request: ${mismatches.join("; ")}`,
          { details: { mismatches, probe, kind: file.kind }, retryable: false },
        );
      }
      deliveries.push({
        kind: file.kind,
        filePath: file.filePath,
        mime: "video/mp4",
        probe,
        ...(file.loudness ? { loudness: file.loudness } : {}),
      });
    }
    return deliveries;
  }
}
