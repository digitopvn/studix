// Adapted from motion-mcp packages/media/src/ffmpeg.ts @ 408ceccd (MIT, Copyright (c) 2026 Digitop).
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { MediaProbe } from "@studix/core";
import { StudixError } from "@studix/shared";
import { runProcess } from "./run-process.ts";

/** Parse an FFmpeg rational (`30000/1001`, `30/1`, `25`); 0 when unknown. */
export function parseRational(value: string | undefined): number {
  if (!value) return 0;
  const [n, d] = value.split("/").map(Number);
  if (n === undefined || !Number.isFinite(n)) return 0;
  if (d === undefined) return n;
  return d > 0 && Number.isFinite(d) ? n / d : 0;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  nb_read_packets?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; size?: string };
}

function parseJson(raw: string): FfprobeOutput {
  try {
    return JSON.parse(raw) as FfprobeOutput;
  } catch (err) {
    throw new StudixError("INTERNAL", "ffprobe returned invalid JSON", { cause: err });
  }
}

/** Normalize `ffprobe -print_format json -show_streams -show_format` output into a MediaProbe. */
export function parseFfprobeJson(raw: string, fallbackBytes = 0): MediaProbe {
  const data = parseJson(raw);
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video) throw new StudixError("VALIDATION", "Media file has no video stream");
  const fps = parseRational(video.avg_frame_rate) || parseRational(video.r_frame_rate);
  const durationSec = Number(data.format?.duration ?? video.duration ?? 0);
  const size = Number(data.format?.size);
  const probe: MediaProbe = {
    durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: Math.round(fps * 1000) / 1000,
    videoCodec: video.codec_name ?? "unknown",
    bytes: Number.isFinite(size) && size > 0 ? size : fallbackBytes,
  };
  if (audio?.codec_name) probe.audioCodec = audio.codec_name;
  return probe;
}

export interface FfmpegProbeOptions {
  /** ffprobe binary; pass config.FFPROBE_PATH. */
  ffprobePath?: string;
  timeoutMs?: number;
}

/** Reads container/stream facts of a media file with ffprobe. */
export class FfmpegProbe {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(options: FfmpegProbeOptions = {}) {
    this.bin = options.ffprobePath ?? "ffprobe";
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async probe(filePath: string, signal?: AbortSignal): Promise<MediaProbe> {
    const { stdout, bytes } = await this.run(filePath, [], signal);
    return parseFfprobeJson(stdout, bytes);
  }

  /** Whether a file carries sound, and its length; works for audio-only files. */
  async audioSource(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<{ hasAudio: boolean; durationMs: number }> {
    const { stdout } = await this.run(filePath, [], signal);
    const data = parseJson(stdout);
    const seconds = Number(data.format?.duration ?? 0);
    return {
      hasAudio: (data.streams ?? []).some((s) => s.codec_type === "audio"),
      durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    };
  }

  /** Stream facts a golden check needs: video frame count (packets read), fps and audio stream count. */
  async streamFacts(filePath: string, signal?: AbortSignal): Promise<StreamFacts> {
    const { stdout } = await this.run(filePath, ["-count_packets"], signal);
    const streams = parseJson(stdout).streams ?? [];
    const video = streams.find((s) => s.codec_type === "video");
    return {
      videoFrames: Number(video?.nb_read_packets ?? 0),
      fps: parseRational(video?.avg_frame_rate) || parseRational(video?.r_frame_rate),
      audioStreams: streams.filter((s) => s.codec_type === "audio").length,
    };
  }

  private async run(
    filePath: string,
    extra: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; bytes: number }> {
    const file = resolve(filePath);
    const info = await stat(file).catch((err: unknown) => {
      throw new StudixError("NOT_FOUND", "Media file to probe does not exist", {
        cause: err,
        details: { file },
      });
    });
    const result = await runProcess(
      this.bin,
      ["-v", "error", ...extra, "-print_format", "json", "-show_streams", "-show_format", file],
      { timeoutMs: this.timeoutMs, signal },
    );
    if (result.exitCode !== 0) {
      throw new StudixError("VALIDATION", `ffprobe could not read the media file (exit ${result.exitCode})`, {
        details: { stderr: result.stderr.slice(-2000) },
      });
    }
    return { stdout: result.stdout, bytes: info.size };
  }
}

export interface StreamFacts {
  videoFrames: number;
  fps: number;
  audioStreams: number;
}

export interface ExpectedMedia {
  width: number;
  height: number;
  durationMs: number;
  videoCodec: string;
  /** Allowed duration drift; defaults to one frame at 12 fps plus container rounding. */
  durationToleranceMs?: number;
}

/** Compare a probe with what the render asked for; returns human-readable mismatches (empty when ok). */
export function probeMismatches(probe: MediaProbe, expected: ExpectedMedia): string[] {
  const issues: string[] = [];
  const tolerance = expected.durationToleranceMs ?? 120;
  if (probe.width !== expected.width || probe.height !== expected.height) {
    issues.push(`resolution ${probe.width}x${probe.height}, expected ${expected.width}x${expected.height}`);
  }
  if (Math.abs(probe.durationMs - expected.durationMs) > tolerance) {
    issues.push(`duration ${probe.durationMs}ms, expected ${expected.durationMs}ms (+/-${tolerance}ms)`);
  }
  if (probe.videoCodec !== expected.videoCodec) {
    issues.push(`video codec ${probe.videoCodec}, expected ${expected.videoCodec}`);
  }
  return issues;
}
