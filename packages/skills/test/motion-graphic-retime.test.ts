import { describe, expect, it } from "vitest";
import {
  cardTimings,
  retimedCardLengths,
  retimeGraphic,
} from "../src/motion-graphic/motion-graphic-retime.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";
import { MAX_VOICE_SPEEDUP, voiceLines } from "../src/voice-lines.ts";

describe("retimedCardLengths", () => {
  it("gives a long take the time short lines do not need, in the same total", () => {
    const cards = [
      { durationMs: 3000, padMs: 300, speechMs: 1000 },
      { durationMs: 3000, padMs: 0, speechMs: 4500 },
      { durationMs: 3000, padMs: 300, speechMs: 1000 },
    ];
    const lengths = retimedCardLengths(cards, 9000) as number[];
    expect(lengths.reduce((a, b) => a + b, 0)).toBe(9000);
    expect(lengths[1]).toBeGreaterThanOrEqual(4500);
    lengths.forEach((ms, i) => {
      expect(ms % 100).toBe(0);
      expect(ms).toBeGreaterThanOrEqual((cards[i]?.padMs ?? 0) + (cards[i]?.speechMs ?? 0));
    });
  });

  it("reads faster, up to the speed-up, before giving up", () => {
    const cards = [
      { durationMs: 3000, padMs: 0, speechMs: 3200 },
      { durationMs: 3000, padMs: 0, speechMs: 3200 },
    ];
    const lengths = retimedCardLengths(cards, 6000) as number[];
    expect(lengths).toEqual([3000, 3000]);
    lengths.forEach((ms) => expect(3200 / ms).toBeLessThanOrEqual(MAX_VOICE_SPEEDUP));
    expect(retimedCardLengths(cards, 5000)).toBeUndefined();
  });
});

describe("retimeGraphic", () => {
  it("moves cards, timeline, captions and lines together", () => {
    const ir = motionGraphicTemplate({
      prompt: "Motion graphic giới thiệu tiệm trà Lá Mây",
      title: "Lá Mây",
      language: "vi",
      durationMs: 12_000,
      keyMessages: ["Trà hái tay mỗi sớm", "Giao tận nơi"],
      callToAction: "Đặt trà ngay",
    });
    const lines = voiceLines(ir);
    const cards = cardTimings(
      ir,
      lines,
      lines.map((l, i) => (i === 1 ? 5000 : 800)),
    );
    const lengths = retimedCardLengths(cards ?? [], ir.format.durationMs) as number[];
    const next = retimeGraphic(ir, lines, lengths);
    expect(next.ir.scenes.map((s) => s.durationMs)).toEqual(lengths);
    expect(next.ir.timeline.entries.map((e) => e.startMs)).toEqual(
      lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0)),
    );
    // Each moved line's captions fill its new room, start to end.
    for (const line of next.lines) {
      const end = line.startMs + line.roomMs;
      const cues = next.ir.captions?.cues.filter((c) => c.startMs >= line.startMs && c.endMs <= end) ?? [];
      expect(cues.map((c) => c.text).join(" ")).toBe(line.text);
      expect([cues[0]?.startMs, cues.at(-1)?.endMs]).toEqual([line.startMs, end]);
    }
    expect(next.lines[1]?.roomMs).toBeGreaterThanOrEqual(5000);
    // Shots that ran to the end of their card still do.
    next.ir.scenes.forEach((scene) => {
      expect(Math.max(...scene.shots.map((sh) => sh.startMs + sh.durationMs))).toBe(scene.durationMs);
    });
  });
});
