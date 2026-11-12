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
  /** Source speed-up (pitch kept); the clip reads `durationMs × rate` of its source. Absent plays as is. */
  rate?: number;
  /** Lowered by this many dB (ramped) wherever a voice-over or dialogue clip plays. */
  duckDb?: number;
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
    const rate = clip.rate ?? 1;
    if (info.durationMs > 0) durationMs = Math.min(durationMs, (info.durationMs - clip.trimStartMs) / rate);
    if (rate !== 1) durationMs = Math.floor(durationMs);
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
        rate: track.playbackRate ?? 1,
        ...(track.duckDb !== undefined && track.duckDb < 0 ? { duckDb: track.duckDb } : {}),
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
          rate: 1,
        },
        shot.assetId,
        shot.durationMs,
      );
    }
  }
  return clips;
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

/** Ducking ramps: the bed starts dipping just before speech and recovers a little after it. */
const DUCK_ATTACK_MS = 150;
const DUCK_RELEASE_MS = 300;
/** Speech windows closer than this stay ducked across the gap, so the bed does not pump between phrases. */
const DUCK_BRIDGE_MS = 400;
/** Most windows one ducking envelope carries; beyond that the closest are bridged to bound the expression. */
const DUCK_MAX_WINDOWS = 64;

type Window = [startMs: number, endMs: number];

/** Absolute spans of every speech clip except `self`, merged where they overlap or nearly touch. */
function speechWindows(clips: readonly AudioClip[], self: number): Window[] {
  const spans = clips
    .filter((c, i) => i !== self && (c.kind === "voiceover" || c.kind === "dialogue"))
    .map((c): Window => [c.startMs, c.startMs + c.durationMs])
    .sort((a, b) => a[0] - b[0]);
  const merged: Window[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] - last[1] < DUCK_BRIDGE_MS) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  while (merged.length > DUCK_MAX_WINDOWS) {
    let best = 0;
    for (let i = 1; i < merged.length - 1; i++) {
      if (merged[i + 1]![0] - merged[i]![1] < merged[best + 1]![0] - merged[best]![1]) best = i;
    }
    merged[best]![1] = Math.max(merged[best]![1], merged[best + 1]![1]);
    merged.splice(best + 1, 1);
  }
  return merged;
}

/**
 * `volume` filter that lowers a clip by `duckDb` inside the speech windows, ramping down over the attack
 * before each window and back up over the release after it. Its `t` is clip-local timeline time (the
 * chain resets timestamps and any tempo change comes before it), so the windows are shifted by the clip
 * start. Undefined when no window touches the clip.
 */
function duckFilter(clip: AudioClip, windows: readonly Window[]): string | undefined {
  if (!clip.duckDb) return undefined;
  const offset = (ms: number) => (ms < 0 ? `+${sec(-ms)}` : `-${sec(ms)}`);
  const terms = windows
    .map(([a, b]): Window => [a - clip.startMs, b - clip.startMs])
    .filter(([a, b]) => b + DUCK_RELEASE_MS > 0 && a - DUCK_ATTACK_MS < clip.durationMs)
    .map(
      ([a, b]) =>
        `clip((t${offset(a - DUCK_ATTACK_MS)})/${sec(DUCK_ATTACK_MS)},0,1)*clip((${sec(b + DUCK_RELEASE_MS)}-t)/${sec(DUCK_RELEASE_MS)},0,1)`,
    );
  if (terms.length === 0) return undefined;
  // Bridged windows never overlap by more than their ramps, so the clamped sum is the deepest dip.
  return `volume=eval=frame:volume='pow(10,${(clip.duckDb / 20).toFixed(4)}*min(1,${terms.join("+")}))'`;
}

/**
 * filter_complex that places every clip (input i = clips[i]) and sums them without normalisation, so a
 * track's volume is its real gain; the sum is padded or cut to exactly `totalMs`. Loudness is set later.
 * A clip with `duckDb` dips under every voice-over and dialogue clip it overlaps.
 */
export function audioMixGraph(clips: readonly AudioClip[], totalMs: number): string {
  if (clips.length === 0) throw new StudixError("INTERNAL", "audio mix needs at least one clip");
  const chains = clips.map((clip, i) => {
    const rate = clip.rate ?? 1;
    const duck = duckFilter(clip, speechWindows(clips, i));
    const filters = [
      `atrim=start=${sec(clip.trimStartMs)}:duration=${sec(clip.durationMs * rate)}`,
      "asetpts=PTS-STARTPTS",
      // atempo keeps the pitch; one stage covers 0.5-2, the range an IR track allows.
      ...(rate !== 1 ? [`atempo=${rate.toFixed(4)}`] : []),
      `aformat=sample_fmts=fltp:sample_rates=${MIX_SAMPLE_RATE}:channel_layouts=stereo`,
      `volume=${clip.volume.toFixed(4)}`,
      ...(duck ? [duck] : []),
    ];
    if (clip.fadeInMs > 0) filters.push(`afade=t=in:st=0:d=${sec(clip.fadeInMs)}`);
    if (clip.fadeOutMs > 0)
      filters.push(`afade=t=out:st=${sec(clip.durationMs - clip.fadeOutMs)}:d=${sec(clip.fadeOutMs)}`);
    if (clip.startMs > 0) {
      filters.push(`adelay=delays=${clip.startMs}:all=1`);
      // After atempo, adelay leaves its silent lead without timestamps on FFmpeg 6.1+, and amix then ends the
      // whole mix at the delay; renumbering the samples gives every frame a real timestamp again.
      if (rate !== 1) filters.push("asetpts=N/SR/TB");
    }
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
