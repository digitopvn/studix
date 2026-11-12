import type { DirectorTiming, HandoffRect } from "@studix/renderers";
import { timingWord } from "@studix/renderers";
import type { VideoIR } from "@studix/video-ir";
import { z } from "zod";
import { MusicBeats } from "./motion-graphic-music.ts";

/** Words as the voice stage keeps them in `metadata.spokenWords`: [text, startMs, endMs] on the graphic. */
const SpokenWords = z.array(z.tuple([z.string(), z.number(), z.number()])).max(5000);

/** Beat length when the graphic has no music bed: 120 BPM, or the style's tempo. */
const DEFAULT_BPM = 120;

const sec = (ms: number) => Math.round(ms) / 1000;

/** Start and end (ms) of every scene on the graphic's timeline, in scene order. */
export function sceneWindows(ir: VideoIR): Array<{ id: string; startMs: number; endMs: number }> {
  let at = 0;
  return ir.scenes.map((sc) => {
    const w = { id: sc.id, startMs: at, endMs: at + sc.durationMs };
    at += sc.durationMs;
    return w;
  });
}

/** The heard words of the graphic, or none when it was voiced before they were kept (or has no voice). */
export function spokenWordsOf(ir: VideoIR): Array<[string, number, number]> {
  const parsed = SpokenWords.safeParse(ir.metadata?.spokenWords);
  return parsed.success ? parsed.data : [];
}

/** One scene's words as W() looks them up: [word, start s, end s] on a clip that starts at `originMs`. */
export function sceneWords(ir: VideoIR, sceneId: string, originMs = 0): Array<[string, number, number]> {
  const win = sceneWindows(ir).find((w) => w.id === sceneId);
  if (!win) return [];
  return spokenWordsOf(ir)
    .filter(([, start]) => start >= win.startMs && start < win.endMs)
    .map(([text, start, end]): [string, number, number] => [
      timingWord(text),
      sec(start - originMs),
      sec(end - originMs),
    ])
    .filter(([w]) => w !== "");
}

/**
 * `window.TIMING` of a clip of one scene: the scene from 0 to its length, every other scene's window rebased
 * onto the clip (a fragment may read its neighbour's start), the music bed's beat grid on the clip, and no
 * captions or fades, because the clip is cut into a film that already burns its captions.
 */
export function sceneClipTiming(
  ir: VideoIR,
  sceneId: string,
  handoff: Record<string, { exit?: HandoffRect; enter?: HandoffRect }> = {},
): DirectorTiming {
  const windows = sceneWindows(ir);
  const win = windows.find((w) => w.id === sceneId);
  if (!win) throw new Error(`scene ${sceneId} is not in the graphic`);
  const origin = win.startMs;
  const duration = sec(win.endMs - origin);
  const scenes: DirectorTiming["scenes"] = {};
  for (const w of windows) {
    const words = sceneWords(ir, w.id, origin);
    scenes[w.id] = {
      start: sec(w.startMs - origin),
      end: sec(w.endMs - origin),
      lines: words.length > 0 ? [{ on: words[0]![1], off: words.at(-1)![2], words }] : [],
    };
  }
  const grid = MusicBeats.safeParse(ir.metadata?.beats).data;
  const bpm = grid?.bpm ?? (typeof ir.metadata?.bpm === "number" ? ir.metadata.bpm : DEFAULT_BPM);
  const beatLen = Math.round((60 / Math.min(240, Math.max(40, bpm))) * 1e6) / 1e6;
  const firstBeat = grid?.beatsMs.find((ms) => ms >= origin);
  const beat0 = firstBeat === undefined ? 0 : sec(firstBeat - origin);
  const beats = Math.max(1, Math.floor((duration - beat0) / beatLen) + 1);
  return {
    duration,
    fps: ir.format.fps,
    beat0,
    beatLen,
    // The bed plays under the whole graphic, so every beat of a scored clip reacts; an unscored one keeps still.
    kick: grid ? [[0, beats]] : [],
    drops: [],
    outroBeat: beats,
    scenes,
    captions: [],
    env: [],
    handoff,
    options: { fadeIn: false, fadeOut: false },
  };
}
