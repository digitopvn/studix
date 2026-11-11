import type { VideoIR } from "@studix/video-ir";

/** Length asked of the CTA accent. */
export const SFX_MS = 1500;
/** Where the accent lands when the IR has no CTA scene: this long before the end. */
const SFX_TAIL_MS = 3000;
/** A cut whoosh starts this much before its cut, so it peaks on it. */
const WHOOSH_LEAD_MS = 150;

export const ACCENT_TRACK_ID = "sfx-accent-track";
export const whooshTrackId = (i: number) => `sfx-whoosh-${i + 1}-track`;

/** Where the accent lands: the start of the CTA card, else `SFX_TAIL_MS` before the end. */
export function accentAt(ir: VideoIR): number {
  const ctaIndex = ir.scenes.findIndex((scene) => scene.id === "cta");
  return ctaIndex === -1
    ? Math.max(0, ir.format.durationMs - SFX_TAIL_MS)
    : ir.scenes.slice(0, ctaIndex).reduce((ms, scene) => ms + scene.durationMs, 0);
}

/** How long the accent plays: its take, at most to the end of the graphic. */
export const accentDurationMs = (ir: VideoIR, takeMs: number | undefined) =>
  Math.min(Math.max(1, ir.format.durationMs - accentAt(ir)), takeMs ?? SFX_MS);

/** Start of every scene after the first, except the CTA card (the accent lands there). */
export function cutTimes(ir: VideoIR): number[] {
  const out: number[] = [];
  let at = 0;
  for (const scene of ir.scenes) {
    if (at > 0 && scene.id !== "cta") out.push(at);
    at += scene.durationMs;
  }
  return out;
}

/** Where the whoosh of a cut at `cutMs` starts. */
export const whooshStart = (cutMs: number) => Math.max(0, cutMs - WHOOSH_LEAD_MS);

/**
 * `ir` with the SFX tracks the accent stage laid moved to its current cards: each cut whoosh leads its cut
 * and the accent lands at the CTA card. For an IR whose cards were re-timed; other tracks are untouched.
 */
export function replaceSfxTracks(ir: VideoIR): VideoIR {
  if (!ir.audio?.length) return ir;
  const cuts = cutTimes(ir);
  const takeMs = (assetId: string) => ir.assets.find((a) => a.id === assetId)?.durationMs;
  return {
    ...ir,
    audio: ir.audio.map((t) => {
      if (t.id === ACCENT_TRACK_ID) {
        return { ...t, startMs: accentAt(ir), durationMs: accentDurationMs(ir, takeMs(t.assetId)) };
      }
      const cut = cuts.findIndex((_, i) => t.id === whooshTrackId(i));
      return cut === -1 ? t : { ...t, startMs: whooshStart(cuts[cut] as number) };
    }),
  };
}
