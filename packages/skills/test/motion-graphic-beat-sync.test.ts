import { type VideoIR, validateVideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { musicCompositionPlan, snapCutsToBeats } from "../src/motion-graphic/motion-graphic-beat-sync.ts";
import {
  estimateWords,
  placeWords,
  spokenWordsOf,
  withSpokenWords,
} from "../src/motion-graphic/motion-graphic-spoken-words.ts";
import { MotionStoryboard } from "../src/motion-graphic/motion-graphic-storyboard.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";

const LINES = [
  "Studix turns one prompt into a video",
  "Connect Claude and ChatGPT in one click",
  "Renders land three times faster",
  "Try Studix today",
];

/**
 * A 12 s graphic of four voiced cards, each line placed 200 ms into its card over 1.6 s (the hook's over
 * `hookMs`, when given).
 */
function voicedGraphic(hookMs = 1600): { ir: VideoIR; starts: number[] } {
  const storyboard = MotionStoryboard.parse({
    styleProfile: "kinetic-typography",
    brandName: "Studix",
    music: "upbeat electronic",
    rationale: "r",
    beats: LINES.map((line, i) => ({
      onScreen: line,
      voiceover: line,
      visual: "card",
      enter: "fade",
      weight: 1,
      layout: i === 1 ? "chips" : null,
      items: i === 1 ? ["Studix", "Claude", "ChatGPT"] : null,
    })),
  });
  const base = motionGraphicTemplate(
    { prompt: "Introduce Studix", aspectRatio: "16:9", durationMs: 12_000 },
    { storyboard },
  );
  const starts: number[] = [];
  let at = 0;
  for (const scene of base.scenes) {
    starts.push(at);
    at += scene.durationMs;
  }
  const tracks = LINES.map((_, i) => ({
    id: `voiceover-${i + 1}-track`,
    kind: "voiceover" as const,
    assetId: `voiceover-${i + 1}`,
    startMs: (starts[i] as number) + 200,
    durationMs: i === 0 ? hookMs : 1600,
    volume: 1,
  }));
  const spoken = LINES.map((line, i) => ({
    card: base.scenes[i]!.id,
    words: placeWords(estimateWords(line, { startMs: 0, endMs: tracks[i]!.durationMs }, "en"), tracks[i]!),
  }));
  const ir: VideoIR = {
    ...base,
    assets: [
      ...base.assets,
      ...tracks.map((t) => ({
        id: t.assetId,
        kind: "audio" as const,
        uri: `https://example.com/${t.assetId}.mp3`,
        sha256: "a".repeat(64),
        mime: "audio/mpeg",
        provenance: { source: "generated" as const },
      })),
    ],
    audio: tracks,
  };
  const texts = new Map(LINES.map((line, i) => [base.scenes[i]!.id, line]));
  return { ir: withSpokenWords(ir, spoken, texts), starts };
}

describe("spoken words", () => {
  it("cues the captions on the words, enters headlines with their first word and starts a device when it is named", () => {
    const { ir, starts } = voicedGraphic();
    expect(validateVideoIR(ir).ok).toBe(true);
    const message = ir.scenes[1]!;
    const headline = message.shots[0] as { startMs: number; layoutAtMs?: number };
    // The first word is heard 200 ms into the card: the headline enters just before it.
    expect(headline.startMs).toBe(120);
    // "Claude" is the first word the chips show that the headline does not lead with ("Connect").
    const claude = spokenWordsOf(ir)[1]!.words.find((w) => w.text === "Claude")!;
    expect(headline.layoutAtMs).toBe(claude.startMs - starts[1]! - headline.startMs - 120);
    const firstCue = ir.captions!.cues.find((c) => c.startMs >= starts[1]!)!;
    expect(firstCue.startMs).toBe(starts[1]! + 200);
  });
});

describe("snapping cuts to beats", () => {
  it("moves each cut to a downbeat in reach, carrying its card's voice, captions and words", () => {
    const { ir, starts } = voicedGraphic();
    const cut = starts[1]!;
    const beats = { bpm: 120, beatsMs: [cut - 500, cut + 250, cut + 750], downbeatsMs: [cut + 250] };
    const { ir: snapped, cuts } = snapCutsToBeats(ir, beats);
    expect(cuts).toEqual([{ fromMs: cut, toMs: cut + 250, on: "downbeat" }]);
    expect(validateVideoIR(snapped).ok).toBe(true);
    expect(snapped.scenes.reduce((n, s) => n + s.durationMs, 0)).toBe(12_000);
    expect(snapped.scenes[0]!.durationMs).toBe(ir.scenes[0]!.durationMs + 250);
    expect(snapped.audio!.find((t) => t.id === "voiceover-2-track")!.startMs).toBe(cut + 450);
    expect(snapped.audio!.find((t) => t.id === "voiceover-1-track")!.startMs).toBe(200);
    expect(spokenWordsOf(snapped)[1]!.words[0]!.startMs).toBe(spokenWordsOf(ir)[1]!.words[0]!.startMs + 250);
    expect(snapped.captions!.cues.some((c) => c.startMs === cut + 450)).toBe(true);
    // Every shot of a card still ends with it.
    for (const scene of snapped.scenes) {
      for (const shot of scene.shots) expect(shot.startMs + shot.durationMs).toBe(scene.durationMs);
    }
  });

  it("leaves a cut alone when the snap would cut into a line", () => {
    const cut = voicedGraphic().starts[1]!;
    // The hook is spoken until 150 ms before the cut: a downbeat 300 ms early would clip its last word.
    const { ir } = voicedGraphic(cut - 350);
    const early = { bpm: 120, beatsMs: [], downbeatsMs: [cut - 300] };
    expect(snapCutsToBeats(ir, early).cuts).toEqual([]);
    expect(snapCutsToBeats(ir, { ...early, downbeatsMs: [cut + 300] }).cuts).toHaveLength(1);
  });
});

describe("music composition plan", () => {
  it("drops on the call to action at the style's tempo, every section long enough, adding up to the length", () => {
    const { ir } = voicedGraphic();
    const plan = musicCompositionPlan(ir, "upbeat electronic");
    const ctaStart = 12_000 - ir.scenes.at(-1)!.durationMs;
    expect(plan.sections.reduce((n, s) => n + s.durationMs, 0)).toBe(12_000);
    expect(plan.sections.every((s) => s.durationMs >= 3000)).toBe(true);
    const drop = plan.sections.at(-1)!;
    expect(drop.name).toBe("Drop");
    expect(12_000 - drop.durationMs).toBe(Math.min(ctaStart, 9000));
    expect(plan.positiveGlobalStyles.some((s) => /\d+ BPM/.test(s))).toBe(true);
  });
});
