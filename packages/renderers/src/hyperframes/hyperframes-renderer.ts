import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RendererAdapter, RendererSupport, RenderOptions, RenderOutput } from "@studix/core";
import { createLogger, type Logger, StudixError, toStudixError } from "@studix/shared";
import { type RenderSpec, renderDimensions, type VideoIR } from "@studix/video-ir";
import { finishMp4 } from "../ffmpeg/ffmpeg-finish.ts";
import { FfmpegProbe, probeMismatches } from "../ffmpeg/ffmpeg-probe.ts";
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
}

/** Progress budget per phase; capture dominates wall time. */
const PHASES = { compile: 0.05, capture: 0.9, finish: 0.97 } as const;

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

  async render(ir: VideoIR, options: RenderOptions): Promise<RenderOutput> {
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

    const { width, height } = renderDimensions(ir.format, spec);
    const fps = spec.fps ?? ir.format.fps;
    const projectDir = join(workDir, "composition");
    const rawPath = join(workDir, "capture.raw.mp4");
    const outputPath = join(workDir, `render-${spec.preset}.mp4`);

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
      report(PHASES.capture, "finish");
      await finishMp4(rawPath, outputPath, {
        ffmpegPath: this.options.ffmpegPath,
        addSilentAudio: true,
        signal,
      });

      report(PHASES.finish, "verify");
      const probe = await this.probe.probe(outputPath, signal);
      const mismatches = probeMismatches(probe, {
        width,
        height,
        durationMs: ir.format.durationMs,
        videoCodec: spec.videoCodec,
        durationToleranceMs: Math.ceil(1000 / fps) + 100,
      });
      if (mismatches.length > 0) {
        throw new StudixError(
          "INTERNAL",
          `Rendered MP4 does not match the request: ${mismatches.join("; ")}`,
          {
            details: { mismatches, probe },
            retryable: false,
          },
        );
      }
      report(1, "complete");
      return { filePath: outputPath, mime: "video/mp4", probe };
    } catch (err) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      if (signal?.aborted) throw err instanceof StudixError && err.code === "CANCELLED" ? err : cancelled();
      throw toStudixError(err);
    } finally {
      await rm(rawPath, { force: true }).catch(() => undefined);
    }
  }
}
