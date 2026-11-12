import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StudixError } from "@studix/shared";
import { type AudioTrackKind, resolveSceneSpans, type VideoIR } from "@studix/video-ir";
import { type RunFfmpegOptions, runFfmpeg } from "./run-process.ts";

/** Mix sample rate; every delivery carries 48 kHz stereo AAC. */
export const MIX_SAMPLE_RATE = 48_000;

/** Music under speech reaches its ducked level over this long, ending as the speech starts. */
export const DUCK_ATTACK_MS = 150;
/** Music returns to its full level over this long, starting as the speech ends. */
export const DUCK_RELEASE_MS = 350;

/** Samples per frame of a ducked clip (5 ms at 48 kHz): its gain steps at most this often. */
const DUCK_FRAME_SAMPLES = 240;

/** Lowers a clip under speech: `gain` (linear, below 1) applies inside each span, with ramps around it. */
export interface AudioDuck {
  gain: number;
  /**
   * Speech in clip-local time (0 = the clip's first sample on the timeline), ascending and apart by at
   * least attack + release, so the ramps of two spans never overlap. A span may start before 0 or end
   * after the clip.
   */
  spans: Array<{ startMs: number; endMs: number }>;
}

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
  /** Music lowered while voiceover or dialogue plays; absent plays at `volume` throughout. */
  duck?: AudioDuck;
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
 * always silent. A music track with `duckDb` is lowered by that much while any placed voiceover or
 * dialogue clip plays; speech stretches closer than attack + release merge into one dip.
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

  const ducked: Array<{ clip: AudioClip; duckDb: number }> = [];
  for (const track of ir.audio ?? []) {
    const before = clips.length;
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
      },
      track.assetId,
      track.durationMs ?? total - track.startMs,
    );
    const placed = clips[before];
    if (placed && track.kind === "music" && track.duckDb !== undefined && track.duckDb < 0) {
      ducked.push({ clip: placed, duckDb: track.duckDb });
    }
  }
  if (ducked.length > 0) {
    const speech = speechSpans(clips);
    for (const { clip, duckDb } of ducked) {
      const spans = speech
        .map((s) => ({ startMs: s.startMs - clip.startMs, endMs: s.endMs - clip.startMs }))
        .filter((s) => s.endMs + DUCK_RELEASE_MS > 0 && s.startMs - DUCK_ATTACK_MS < clip.durationMs);
      if (spans.length > 0) clip.duck = { gain: 10 ** (duckDb / 20), spans };
    }
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

/** Absolute stretches where voiceover or dialogue plays, merged when the music could not recover between. */
function speechSpans(clips: readonly AudioClip[]): Array<{ startMs: number; endMs: number }> {
  const spans = clips
    .filter((c) => c.kind === "voiceover" || c.kind === "dialogue")
    .map((c) => ({ startMs: c.startMs, endMs: c.startMs + c.durationMs }))
    .sort((a, b) => a.startMs - b.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.startMs - last.endMs < DUCK_ATTACK_MS + DUCK_RELEASE_MS) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

/**
 * FFmpeg `volume` filter that follows a duck envelope over clip-local time `t`: full level outside the
 * spans, `gain` inside, linear ramps of attack before and release after each span. Spans are far enough
 * apart that their ramps never overlap, so the per-span depths add up to at most 1. The expression is
 * quoted so its commas stay inside the filter.
 */
function duckFilter(duck: AudioDuck): string {
  const att = sec(DUCK_ATTACK_MS);
  const rel = sec(DUCK_RELEASE_MS);
  const depth = duck.spans
    .map(
      (s) =>
        `clip(min((t-${sec(s.startMs - DUCK_ATTACK_MS)})/${att},(${sec(s.endMs + DUCK_RELEASE_MS)}-t)/${rel}),0,1)`,
    )
    .join("+");
  return `volume=volume='1-${(1 - duck.gain).toFixed(4)}*(${depth})':eval=frame`;
}

/**
 * filter_complex that places every clip (input i = clips[i]) and sums them without normalisation, so a
 * track's volume is its real gain; the sum is padded or cut to exactly `totalMs`. Loudness is set later.
 */
export function audioMixGraph(clips: readonly AudioClip[], totalMs: number): string {
  if (clips.length === 0) throw new StudixError("INTERNAL", "audio mix needs at least one clip");
  const chains = clips.map((clip, i) => {
    const rate = clip.rate ?? 1;
    const filters = [
      `atrim=start=${sec(clip.trimStartMs)}:duration=${sec(clip.durationMs * rate)}`,
      "asetpts=PTS-STARTPTS",
      // atempo keeps the pitch; one stage covers 0.5-2, the range an IR track allows.
      ...(rate !== 1 ? [`atempo=${rate.toFixed(4)}`] : []),
      `aformat=sample_fmts=fltp:sample_rates=${MIX_SAMPLE_RATE}:channel_layouts=stereo`,
      `volume=${clip.volume.toFixed(4)}`,
      // After atrim/asetpts (and atempo) the frame time is clip-local timeline time, as the spans are. The
      // gain is set once per frame, so short frames keep the ramps smooth instead of stepping audibly.
      ...(clip.duck ? [`asetnsamples=n=${DUCK_FRAME_SAMPLES}:p=0`, duckFilter(clip.duck)] : []),
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
