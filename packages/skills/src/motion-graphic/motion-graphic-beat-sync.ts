import type { MusicBeats } from "@studix/renderers";
import {
  type AudioTrack,
  buildSequentialTimeline,
  type CaptionCue,
  type Scene,
  type Shot,
  type VideoIR,
} from "@studix/video-ir";
import { VO_PAD_MS } from "../marketing-video/marketing-script.ts";
import { replaceSfxTracks } from "./motion-graphic-sfx-timing.ts";
import { type CardWords, SPOKEN_WORDS_KEY, spokenWordsOf } from "./motion-graphic-spoken-words.ts";

/** A cut moves to a downbeat at most this far away. */
const DOWNBEAT_TOLERANCE_MS = 400;
/** With no downbeat in reach, a cut moves to a beat at most this far away. */
const BEAT_TOLERANCE_MS = 150;
/** Silence kept between a card's last word and the cut after it. */
const SPEECH_GAP_MS = 100;
/** Shortest card a snapped cut may leave. */
const MIN_CARD_MS = 1000;
/** Shortest section ElevenLabs composes. */
const MIN_SECTION_MS = 3000;

export interface SnappedCut {
  /** The cut before the snap, and where it is now. */
  fromMs: number;
  toMs: number;
  on: "downbeat" | "beat";
}

/** How far each card's speech reaches: its first word's start and last word's end (or its voice track). */
function speechByCard(
  ir: VideoIR,
  starts: readonly number[],
): Array<{ startMs: number; endMs: number } | undefined> {
  const out: Array<{ startMs: number; endMs: number } | undefined> = ir.scenes.map(() => undefined);
  const widen = (i: number, startMs: number, endMs: number) => {
    const had = out[i];
    out[i] = had
      ? { startMs: Math.min(had.startMs, startMs), endMs: Math.max(had.endMs, endMs) }
      : { startMs, endMs };
  };
  const cardAt = (ms: number) => {
    let card = -1;
    starts.forEach((s, i) => {
      if (ms >= s) card = i;
    });
    return card;
  };
  const worded = new Set<number>();
  for (const entry of spokenWordsOf(ir)) {
    const i = ir.scenes.findIndex((sc) => sc.id === entry.card);
    if (i === -1) continue;
    worded.add(i);
    for (const w of entry.words) widen(i, w.startMs, w.endMs);
  }
  // A voice track without recorded words counts whole: its speech may run to its end.
  for (const t of ir.audio ?? []) {
    if (t.kind !== "voiceover" && t.kind !== "dialogue") continue;
    const i = cardAt(t.startMs);
    if (i === -1 || worded.has(i)) continue;
    widen(i, t.startMs, t.startMs + (t.durationMs ?? ir.format.durationMs - t.startMs));
  }
  return out;
}

/** Shots of a card cut from `fromMs` long to `toMs`: a shot that ran to the card's end still does. */
function refit(shots: readonly Shot[], fromMs: number, toMs: number): Shot[] {
  return shots.map((shot) => {
    const toEnd = shot.startMs + shot.durationMs >= fromMs;
    const startMs = shot.startMs < toMs - 1 ? shot.startMs : 0;
    const durationMs = Math.max(1, toEnd ? toMs - startMs : Math.min(shot.durationMs, toMs - startMs));
    const next = { ...shot, startMs, durationMs } as Shot;
    if ((next.type === "title" || next.type === "text") && next.layoutAtMs !== undefined) {
      return { ...next, layoutAtMs: Math.min(next.layoutAtMs, durationMs - 1) };
    }
    return next;
  });
}

/**
 * `ir` with its cuts on the music: each cut between cards moves to the nearest downbeat within
 * `DOWNBEAT_TOLERANCE_MS`, else the nearest beat within `BEAT_TOLERANCE_MS`, only when both cards still
 * hold their speech (a short gap before the cut, the closing pad on the last card) and stay at least
 * `MIN_CARD_MS` long. Each card's voice-over, captions and recorded words move with it, its shots stretch
 * or shrink with it, and the cut whooshes and CTA accent follow the new cuts. The graphic's length, the
 * music and anything else are unchanged.
 */
export function snapCutsToBeats(ir: VideoIR, beats: MusicBeats): { ir: VideoIR; cuts: SnappedCut[] } {
  const n = ir.scenes.length;
  const total = ir.format.durationMs;
  const starts: number[] = [];
  let cursor = 0;
  for (const scene of ir.scenes) {
    starts.push(cursor);
    cursor += scene.durationMs;
  }
  if (n < 2 || cursor !== total) return { ir, cuts: [] };
  const speech = speechByCard(ir, starts);
  const endOf = (i: number) => (i + 1 < n ? (starts[i + 1] as number) : total);
  /** Whether card i, shifted by `shift`, holds its speech between `from` and `to`. */
  const holds = (i: number, shift: number, from: number, to: number) => {
    if (to - from < MIN_CARD_MS) return false;
    const said = speech[i];
    if (!said) return true;
    const gap = i === n - 1 ? VO_PAD_MS : SPEECH_GAP_MS;
    return said.startMs + shift >= from && said.endMs + shift + gap <= to;
  };
  const shift: number[] = ir.scenes.map(() => 0);
  const cuts: SnappedCut[] = [];
  for (let k = 1; k < n; k++) {
    const at = starts[k] as number;
    const near = (list: readonly number[], tolerance: number) =>
      list.filter((t) => Math.abs(t - at) <= tolerance).sort((a, b) => Math.abs(a - at) - Math.abs(b - at));
    const candidates = [
      ...near(beats.downbeatsMs, DOWNBEAT_TOLERANCE_MS).map((t) => ({ t, on: "downbeat" as const })),
      ...near(beats.beatsMs, BEAT_TOLERANCE_MS).map((t) => ({ t, on: "beat" as const })),
    ];
    const prevStart = (starts[k - 1] as number) + (shift[k - 1] as number);
    const pick = candidates.find(
      ({ t }) =>
        t > 0 &&
        t < total &&
        holds(k - 1, shift[k - 1] as number, prevStart, t) &&
        holds(k, t - at, t, endOf(k)),
    );
    if (!pick) continue;
    shift[k] = pick.t - at;
    if (pick.t !== at) cuts.push({ fromMs: at, toMs: pick.t, on: pick.on });
  }
  if (cuts.length === 0) return { ir, cuts };

  const newStart = (i: number) => (starts[i] as number) + (shift[i] as number);
  const newEnd = (i: number) => (i + 1 < n ? newStart(i + 1) : total);
  const cardAt = (ms: number) => {
    let card = 0;
    starts.forEach((s, i) => {
      if (ms >= s) card = i;
    });
    return card;
  };
  const scenes: Scene[] = ir.scenes.map((scene, i) => {
    const durationMs = newEnd(i) - newStart(i);
    return durationMs === scene.durationMs
      ? scene
      : { ...scene, durationMs, shots: refit(scene.shots, scene.durationMs, durationMs) };
  });
  const audio = (ir.audio ?? []).map((t): AudioTrack => {
    if (t.kind !== "voiceover" && t.kind !== "dialogue") return t;
    const i = cardAt(t.startMs);
    const startMs = t.startMs + (shift[i] as number);
    const room = newEnd(i) - startMs;
    const durationMs = Math.max(1, Math.min(t.durationMs ?? room, room));
    const fadeOutMs = t.fadeOutMs === undefined ? undefined : Math.min(t.fadeOutMs, durationMs);
    return { ...t, startMs, durationMs, ...(fadeOutMs !== undefined ? { fadeOutMs } : {}) };
  });
  const cues = ir.captions?.cues.flatMap((c): CaptionCue[] => {
    const i = cardAt(c.startMs);
    const startMs = c.startMs + (shift[i] as number);
    const endMs = Math.min(c.endMs + (shift[i] as number), newEnd(i));
    return endMs > startMs ? [{ ...c, startMs, endMs }] : [];
  });
  const words: CardWords[] = spokenWordsOf(ir).map((entry) => {
    const i = Math.max(
      0,
      ir.scenes.findIndex((sc) => sc.id === entry.card),
    );
    const by = shift[i] as number;
    return {
      card: entry.card,
      words: entry.words.map((w) => ({ ...w, startMs: w.startMs + by, endMs: w.endMs + by })),
    };
  });
  const next: VideoIR = replaceSfxTracks({
    ...ir,
    scenes,
    timeline: buildSequentialTimeline(scenes),
    audio,
    ...(ir.captions && cues && cues.length > 0 ? { captions: { ...ir.captions, cues } } : {}),
    metadata: {
      ...(ir.metadata ?? {}),
      ...(words.length > 0 ? { [SPOKEN_WORDS_KEY]: words } : {}),
    },
  });
  return { ir: next, cuts };
}

/** A music composition plan in the provider-neutral shape the media layer takes as `params.compositionPlan`. */
export interface MusicCompositionPlan {
  positiveGlobalStyles: string[];
  negativeGlobalStyles?: string[];
  sections: Array<{ name: string; positiveStyles: string[]; negativeStyles?: string[]; durationMs: number }>;
}

/** The tempo asked of the music: the middle of the style profile's BPM band, when the IR carries one. */
export function targetBpm(ir: VideoIR): number | undefined {
  const band = ir.metadata?.bpm;
  if (!Array.isArray(band) || band.length !== 2) return undefined;
  const [lo, hi] = band as unknown[];
  return typeof lo === "number" && typeof hi === "number" ? Math.round((lo + hi) / 2) : undefined;
}

/** The BPM range beats are searched in: the style's band with some room, else the analyser's default. */
export function bpmSearchRange(ir: VideoIR): readonly [number, number] | undefined {
  const band = ir.metadata?.bpm;
  if (!Array.isArray(band) || band.length !== 2) return undefined;
  const [lo, hi] = band as unknown[];
  if (typeof lo !== "number" || typeof hi !== "number") return undefined;
  return [Math.max(60, Math.floor(lo * 0.9)), Math.min(190, Math.ceil(hi * 1.1))];
}

/**
 * The music bed composed to the cards: an intro under the hook, a build under the message cards and a drop
 * that lands where the call to action starts, at the style's tempo. Every section is at least
 * `MIN_SECTION_MS` (the drop starts earlier, or the build folds into the intro, when a card is too short),
 * and the sections add up to the graphic's length.
 */
export function musicCompositionPlan(ir: VideoIR, mood: string): MusicCompositionPlan {
  const total = ir.format.durationMs;
  const scenes = ir.scenes;
  const ctaStart = total - (scenes.at(-1)?.durationMs ?? 0);
  const firstCut = scenes[0]?.durationMs ?? 0;
  const dropAt = Math.max(MIN_SECTION_MS, Math.min(ctaStart, total - MIN_SECTION_MS));
  const introEnd = Math.min(Math.max(MIN_SECTION_MS, firstCut), dropAt);
  const bpm = targetBpm(ir);
  const intro = {
    name: "Intro",
    positiveStyles: ["sparse", "establishing the groove", "filtered"],
    durationMs: introEnd,
  };
  const build = {
    name: "Build",
    positiveStyles: ["rising energy", "building tension toward the drop", "steady pulse"],
    durationMs: dropAt - introEnd,
  };
  const drop = {
    name: "Drop",
    positiveStyles: ["full energy drop on the first downbeat", "punchy", "confident resolve"],
    durationMs: total - dropAt,
  };
  const sections =
    total < 2 * MIN_SECTION_MS
      ? [{ ...drop, name: "Main", durationMs: total }]
      : build.durationMs >= MIN_SECTION_MS
        ? [intro, build, drop]
        : [{ ...intro, durationMs: dropAt }, drop];
  return {
    positiveGlobalStyles: [
      mood.slice(0, 200),
      "instrumental",
      ...(bpm !== undefined ? [`${bpm} BPM`, "steady 4/4 beat with clear downbeats"] : ["clear 4/4 beat"]),
    ],
    negativeGlobalStyles: ["vocals", "singing", "spoken word", "tempo changes"],
    sections,
  };
}
