import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StudixError } from "@studix/shared";
import { type AudioTrackKind, resolveSceneSpans, type VideoIR } from "@studix/video-ir";
import { type RunFfmpegOptions, runFfmpeg } from "./run-process.ts";

/** Mix sample rate; every delivery carries 48 kHz stereo AAC. */
export const MIX_SAMPLE_RATE = 48_000;

/** One placed piece of sound on the absolute timeline, already clamped to its source. */
export interface AudioClip {
  /** IR audio track id, or the video shot id for clip sound. */
  id: string;
  kind: AudioTrackKind | "video";
  /** Local file with at least one audio stream. */
  file: string;
  startMs: number;
  durationMs: number;
  /** Offset into the source. */
  trimStartMs: number;
  /** Linear gain: the track's `volume` scaled by its `gainDb`, so it may exceed 1. */
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
}

/** What the planner needs to know about a source file. */
export interface AudioSourceInfo {
  hasAudio: boolean;
  /** Source length; 0 when unknown (the clip is then not clamped). */
  durationMs: number;
}

/**
 * Turns IR audio tracks and the sound of unmuted video shots into placed clips. A clip never runs past
 * the video or past the end of its source (after the trim), and its fades are shortened to fit inside
 * it. Video shots whose source has no audio stream contribute nothing; scene video backgrounds are
 * always silent.
 */
export function planAudioClips(
  ir: VideoIR,
  assetFiles: Readonly<Record<string, string>>,
  sources: ReadonlyMap<string, AudioSourceInfo>,
): AudioClip[] {
  const total = ir.format.durationMs;
  const clips: AudioClip[] = [];
  const place = (clip: Omit<AudioClip, "file" | "durationMs">, assetId: string, wantedMs: number) => {
    const file = assetFiles[assetId];
    const info = file ? sources.get(file) : undefined;
    if (!file || !info?.hasAudio) return;
    let durationMs = Math.min(wantedMs, total - clip.startMs);
    if (info.durationMs > 0) durationMs = Math.min(durationMs, info.durationMs - clip.trimStartMs);
    if (durationMs <= 0) return;
    const fadeInMs = Math.min(clip.fadeInMs, durationMs);
    const fadeOutMs = Math.min(clip.fadeOutMs, durationMs - fadeInMs);
    clips.push({ ...clip, file, durationMs, fadeInMs, fadeOutMs });
  };

  for (const track of ir.audio ?? []) {
    place(
      {
        id: track.id,
        kind: track.kind,
        startMs: track.startMs,
        trimStartMs: track.trimStartMs ?? 0,
        volume: track.volume * 10 ** ((track.gainDb ?? 0) / 20),
        fadeInMs: track.fadeInMs ?? 0,
        fadeOutMs: track.fadeOutMs ?? 0,
      },
      track.assetId,
      track.durationMs ?? total - track.startMs,
    );
  }

  const scenes = new Map(ir.scenes.map((s) => [s.id, s]));
  for (const span of resolveSceneSpans(ir.timeline, ir.scenes)) {
    for (const shot of scenes.get(span.sceneId)?.shots ?? []) {
      if (shot.type !== "video" || shot.muted) continue;
      place(
        {
          id: shot.id,
          kind: "video",
          startMs: span.startMs + shot.startMs,
          trimStartMs: shot.trimStartMs ?? 0,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
        },
        shot.assetId,
        shot.durationMs,
      );
    }
  }
  return clips;
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

/**
 * filter_complex that places every clip (input i = clips[i]) and sums them without normalisation, so a
 * track's volume is its real gain; the sum is padded or cut to exactly `totalMs`. Loudness is set later.
 */
export function audioMixGraph(clips: readonly AudioClip[], totalMs: number): string {
  if (clips.length === 0) throw new StudixError("INTERNAL", "audio mix needs at least one clip");
  const chains = clips.map((clip, i) => {
    const filters = [
      `atrim=start=${sec(clip.trimStartMs)}:duration=${sec(clip.durationMs)}`,
      "asetpts=PTS-STARTPTS",
      `aformat=sample_fmts=fltp:sample_rates=${MIX_SAMPLE_RATE}:channel_layouts=stereo`,
      `volume=${clip.volume.toFixed(4)}`,
    ];
    if (clip.fadeInMs > 0) filters.push(`afade=t=in:st=0:d=${sec(clip.fadeInMs)}`);
    if (clip.fadeOutMs > 0)
      filters.push(`afade=t=out:st=${sec(clip.durationMs - clip.fadeOutMs)}:d=${sec(clip.fadeOutMs)}`);
    if (clip.startMs > 0) filters.push(`adelay=delays=${clip.startMs}:all=1`);
    return `[${i}:a:0]${filters.join(",")}[c${i}]`;
  });
  const inputs = clips.map((_, i) => `[c${i}]`).join("");
  const total = sec(totalMs);
  return [
    ...chains,
    `${inputs}amix=inputs=${clips.length}:duration=longest:normalize=0,apad=whole_dur=${total},atrim=duration=${total}[mix]`,
  ].join(";");
}

/** Render the placed clips to one 48 kHz stereo float WAV of exactly `totalMs`. */
export async function mixAudio(
  clips: readonly AudioClip[],
  totalMs: number,
  output: string,
  options: RunFfmpegOptions,
): Promise<void> {
  const out = resolve(output);
  const args: string[] = [];
  for (const clip of clips) args.push("-i", resolve(clip.file));
  args.push("-filter_complex", audioMixGraph(clips, totalMs), "-map", "[mix]");
  args.push("-c:a", "pcm_f32le", "-ar", String(MIX_SAMPLE_RATE), "-n", out);
  await mkdir(dirname(out), { recursive: true });
  await rm(out, { force: true });
  await runFfmpeg("audio mix", args, options).catch(async (err: unknown) => {
    await rm(out, { force: true });
    throw err;
  });
}
