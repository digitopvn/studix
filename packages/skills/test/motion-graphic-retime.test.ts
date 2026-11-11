import { describe, expect, it } from "vitest";
import { MAX_VOICE_SPEEDUP } from "../src/marketing-video/marketing-script.ts";
import { retimeCards, type TakeLength } from "../src/motion-graphic/motion-graphic-retime.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";
import { voiceLines, voiceTakeFits } from "../src/voice-lines.ts";

const brief = {
  prompt: "Motion graphic giới thiệu tiệm trà Lá Mây",
  title: "Lá Mây",
  language: "vi",
  durationMs: 12_000,
  keyMessages: ["Trà hái tay mỗi sớm", "Giao tận nơi trong ngày"],
  callToAction: "Đặt trà ngay",
};
const ir = motionGraphicTemplate(brief);
/** The graphic cut to `cardMs`, and its lines without the script estimate (the cards were cut to takes). */
const recutLines = (cardMs: number[]) =>
  voiceLines(motionGraphicTemplate(brief, { cardMs }), 0, 12_000, { estimate: false });
const lines = voiceLines(ir);
const cards = ir.scenes.map((sc) => sc.durationMs);
/** A take that is all speech, `ms` long. */
const take = (ms: number): TakeLength => ({ lengthMs: ms, measured: { startMs: 0, endMs: ms } });

describe("retimeCards", () => {
  it("keeps the cards when every take fits its card as voiced", () => {
    expect(
      retimeCards(
        ir,
        lines,
        lines.map((l) => take(l.roomMs)),
      ),
    ).toEqual(cards);
  });

  it("gives a long take's card the time short takes leave, keeping the length", () => {
    const takes = lines.map((_, i) => take(i === 1 ? 4_500 : 1_500));
    const out = retimeCards(ir, lines, takes) as number[];
    expect(out.reduce((a, b) => a + b, 0)).toBe(12_000);
    expect(out[1]).toBeGreaterThanOrEqual(4_500);
    // Re-cut through the template, every take now fits its new card at its own pace.
    recutLines(out).forEach((line, i) => {
      expect(line.roomMs).toBeGreaterThanOrEqual(takes[i]?.lengthMs ?? 0);
    });
  });

  it("reads the takes a little faster when together they outrun the graphic as voiced", () => {
    // 4 x 2950 ms of speech and the 600 ms of pads: 12.4 s as voiced, under 12 s read up to 4 % faster.
    const takes = lines.map(() => take(2_950));
    const out = retimeCards(ir, lines, takes) as number[];
    expect(out.reduce((a, b) => a + b, 0)).toBe(12_000);
    recutLines(out).forEach((line, i) => {
      expect(voiceTakeFits(line, takes[i]?.lengthMs, takes[i]?.measured)).toBe(true);
    });
  });

  it("gives up only when the takes cannot fit the graphic even read at the fastest pace", () => {
    const most = Math.floor((12_000 - 600) * MAX_VOICE_SPEEDUP);
    expect(
      retimeCards(
        ir,
        lines,
        lines.map(() => take(Math.ceil(most / 4) + 100)),
      ),
    ).toBeUndefined();
  });

  it("keeps a card whose take has no known length as it is", () => {
    const takes: TakeLength[] = lines.map((_, i) => (i === 0 ? { lengthMs: undefined } : take(1_500)));
    takes[2] = take(4_000);
    const out = retimeCards(ir, lines, takes) as number[];
    expect(out[0]).toBe(cards[0]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(12_000);
  });
});
