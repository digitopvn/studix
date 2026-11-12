import { describe, expect, it } from "vitest";
import { beatsOf, MIN_SECTION_MS, musicSections } from "../src/motion-graphic/motion-graphic-music.ts";
import { MG_STAGES, motionGraphicVoiceStage } from "../src/motion-graphic/motion-graphic-pack.ts";
import {
  cardMinimums,
  snapCutsToBeats,
  type TakeLength,
} from "../src/motion-graphic/motion-graphic-retime.ts";
import {
  heardWords,
  LAYOUT_LATEST_MS,
  REVEAL_LEAD_MS,
  withSpokenReveals,
} from "../src/motion-graphic/motion-graphic-reveals.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";
import { estimateWords } from "../src/spoken-words.ts";
import { voiceLines } from "../src/voice-lines.ts";

const brief = {
  prompt: "Motion graphic giới thiệu tiệm trà Lá Mây",
  title: "Lá Mây",
  language: "vi",
  durationMs: 12_000,
  keyMessages: ["Trà hái tay mỗi sớm", "Giao tận nơi trong ngày"],
  callToAction: "Đặt trà ngay",
};
const ir = motionGraphicTemplate(brief);
const cards = ir.scenes.map((sc) => sc.durationMs);
const take = (ms: number): TakeLength => ({ lengthMs: ms, measured: { startMs: 0, endMs: ms } });
/** A 120 BPM grid from 0: a beat every 500 ms, a downbeat every 2 s. */
const grid = (totalMs: number) => {
  const beatsMs: number[] = [];
  for (let t = 0; t < totalMs; t += 500) beatsMs.push(t);
  return { beatsMs, downbeatsMs: beatsMs.filter((t) => t % 2000 === 0) };
};
const cutsOf = (ms: readonly number[]) =>
  ms.slice(0, -1).map((_, i) => ms.slice(0, i + 1).reduce((a, b) => a + b));

describe("snapCutsToBeats", () => {
  it("moves each cut onto a near downbeat, else a near beat, keeping the length", () => {
    // 2100 is 100 ms past a downbeat; 4700 has no downbeat within 400 ms but a beat 200 ms away.
    const out = snapCutsToBeats([2100, 2600, 1650, 1500], [0, 0, 0, 0], grid(7850));
    expect(out.cardMs.reduce((a, b) => a + b, 0)).toBe(7850);
    expect(cutsOf(out.cardMs)).toEqual([2000, 4500, 6000]);
    expect(out.snapped).toBe(3);
  });

  it("gives the cut into the CTA card a wider downbeat window, where the music drops", () => {
    // 6700 is 200 ms from a beat but 700 ms from the downbeat at 6000: the drop takes the downbeat.
    const out = snapCutsToBeats([2000, 4700, 3300], [0, 0, 0], grid(10_000));
    expect(cutsOf(out.cardMs)).toEqual([2000, 6000]);
    expect(out.snapped).toBe(2);
  });

  it("never shortens a card below its minimum", () => {
    // Snapping 2100 back to 2000 would leave the second card 50 ms short of its 3300 ms.
    const out = snapCutsToBeats([2100, 3150, 2600], [0, 3300, 0], grid(7850));
    expect(out.cardMs[0]).toBe(2100);
    expect(out.cardMs[1]).toBeGreaterThanOrEqual(3300);
    expect(out.cardMs.reduce((a, b) => a + b, 0)).toBe(7850);
  });

  it("keeps the cards of a graphic whose cuts sit far from every beat", () => {
    const out = snapCutsToBeats([2500, 4000], [0, 0], { beatsMs: [0, 1000, 4000], downbeatsMs: [0, 4000] });
    expect(out).toEqual({ cardMs: [2500, 4000], snapped: 0 });
  });
});

describe("cardMinimums", () => {
  const lines = voiceLines(ir);
  it("is what each take needs, never more than the card already has", () => {
    const mins = cardMinimums(
      ir,
      lines,
      lines.map(() => take(800)),
      cards,
    ) as number[];
    mins.forEach((m, i) => {
      expect(m).toBeLessThanOrEqual(cards[i] as number);
      expect(m).toBeGreaterThan(0);
    });
    const tight = cardMinimums(
      ir,
      lines,
      lines.map(() => take(20_000)),
      cards,
    ) as number[];
    expect(tight).toEqual(cards);
  });
});

describe("musicSections", () => {
  it("lays an intro under the hook, a build and the drop on the CTA card, adding up to the graphic", () => {
    const sections = musicSections(ir);
    expect(sections.map((sc) => sc.name)).toEqual(["intro", "build", "drop"]);
    expect(sections.reduce((n, sc) => n + sc.durationMs, 0)).toBe(12_000);
    const ctaStart = cards.slice(0, -1).reduce((a, b) => a + b, 0);
    const drop = 12_000 - (sections.at(-1)?.durationMs ?? 0);
    expect(drop).toBe(Math.min(ctaStart, 12_000 - MIN_SECTION_MS));
    expect(sections.every((sc) => sc.durationMs >= MIN_SECTION_MS)).toBe(true);
  });

  it("keeps the build and the drop, or one section, when the graphic is too short for three", () => {
    const short = motionGraphicTemplate({ ...brief, durationMs: 7000, keyMessages: [] });
    expect(musicSections(short).map((sc) => sc.name)).toEqual(["build", "drop"]);
    expect(musicSections(short).every((sc) => sc.durationMs >= MIN_SECTION_MS)).toBe(true);
    const tiny = { ...short, format: { ...short.format, durationMs: 5000 } };
    expect(musicSections(tiny)).toEqual([expect.objectContaining({ name: "drop", durationMs: 5000 })]);
  });

  it("reads the beat grid only when the music stage kept one", () => {
    expect(beatsOf(ir)).toBeUndefined();
    const beats = { bpm: 120, ...grid(12_000) };
    expect(beatsOf({ ...ir, metadata: { ...ir.metadata, beats } })).toEqual(beats);
  });
});

describe("spoken reveals", () => {
  it("places a take's words on the timeline through its trim and speed", () => {
    const words = [
      { text: "a", startMs: 100, endMs: 300 },
      { text: "b", startMs: 400, endMs: 600 },
    ];
    expect(
      heardWords(words, {
        id: "t",
        kind: "voiceover",
        assetId: "v",
        startMs: 1000,
        volume: 1,
        trimStartMs: 200,
        playbackRate: 2,
      }),
    ).toEqual([{ text: "b", startMs: 1100, endMs: 1200 }]);
  });

  it("reveals a layout card's headline on its shared word and its layout on the next one", () => {
    const base = ir;
    const withLayout = {
      ...base,
      scenes: base.scenes.map((sc, i) =>
        i === 1
          ? {
              ...sc,
              // The headline names part of the line; the layout shows the rest.
              shots: [
                ...sc.shots.map((sh) => (sh.type === "text" ? { ...sh, text: "Trà hái tay" } : sh)),
                {
                  id: "message-1-layout",
                  type: "layout" as const,
                  startMs: 0,
                  durationMs: sc.durationMs,
                  layout: { kind: "prompt-box" as const, text: "Trà hái tay" },
                },
              ],
            }
          : sc,
      ),
    } as typeof base;
    const start = base.scenes[0]?.durationMs ?? 0;
    const words = [
      { text: "Trà", startMs: 200, endMs: 400 },
      { text: "hái", startMs: 450, endMs: 600 },
      { text: "tay", startMs: 650, endMs: 800 },
      { text: "mỗi", startMs: 900, endMs: 1100 },
      { text: "sớm", startMs: 1150, endMs: 1400 },
    ];
    const track = { id: "vo-2", kind: "voiceover" as const, assetId: "v2", startMs: start, volume: 1 };
    const out = withSpokenReveals(withLayout, [{ card: 1, words, track }]);
    const shots = out.scenes[1]?.shots ?? [];
    const headline = shots.find((sh) => sh.type === "text");
    const layout = shots.find((sh) => sh.type === "layout");
    expect(headline?.startMs).toBe(200 - REVEAL_LEAD_MS);
    // The device follows the headline at once instead of waiting for its word.
    expect(layout?.startMs).toBe(200 - REVEAL_LEAD_MS + 300);
    expect(layout?.startMs).toBeLessThanOrEqual(LAYOUT_LATEST_MS);
    expect((layout?.startMs ?? 0) + (layout?.durationMs ?? 0)).toBe(out.scenes[1]?.durationMs);
    // Cards without a line keep their reveal times.
    expect(out.scenes[0]).toEqual(withLayout.scenes[0]);
  });
});

describe("estimateWords", () => {
  it("spreads the words over the speech in order, inside it", () => {
    const words = estimateWords("Trà hái tay mỗi sớm", { startMs: 100, endMs: 1600 });
    expect(words.map((w) => w.text)).toEqual(["Trà", "hái", "tay", "mỗi", "sớm"]);
    expect(words[0]?.startMs).toBe(100);
    expect((words.at(-1)?.endMs ?? 0) <= 1600).toBe(true);
    words.slice(1).forEach((w, i) => {
      expect(w.startMs).toBeGreaterThanOrEqual(words[i]?.endMs ?? 0);
    });
    expect(estimateWords("", { startMs: 0, endMs: 100 })).toEqual([]);
  });
});

describe("voice checkpoint", () => {
  const bed = { id: "music-bed-track", kind: "music" as const, assetId: "m", startMs: 0, volume: 0.3 };
  const voiced = (audio: (typeof bed)[], wordSync?: string) => ({
    ir: { ...ir, audio, metadata: { ...ir.metadata, ...(wordSync ? { wordSync } : {}) } },
  });
  const valid = (output: unknown, saved: Record<string, unknown>) =>
    motionGraphicVoiceStage.isCheckpointValid?.(output as never, saved as never);

  it("is voiced again when it predates word sync or was laid without the music bed", () => {
    const music = { [MG_STAGES.music]: { ir: { ...ir, audio: [bed] } } };
    expect(valid(voiced([bed], "estimate"), music)).toBe(true);
    expect(valid(voiced([bed]), music)).toBe(false);
    expect(valid(voiced([], "alignment"), music)).toBe(false);
    expect(valid(voiced([], "alignment"), {})).toBe(true);
  });
});
