import { describe, expect, it } from "vitest";
import { deliveryOf, deliveryProblems, skillAgentPipeline } from "../src/skill-agent/skill-agent-pack.ts";

const ok = { width: 1920, height: 1080, durationMs: 10_100, audioCodec: "aac" };
const loud = { integratedLufs: -16.3, truePeakDbtp: -1.5 };

describe("skill-agent delivery contract", () => {
  it("asks for 1080p at the brief's aspect ratio and length", () => {
    expect(deliveryOf({ prompt: "x" })).toEqual({ width: 1920, height: 1080, durationMs: 10_000 });
    expect(deliveryOf({ prompt: "x", aspectRatio: "9:16", durationMs: 15_000 })).toEqual({
      width: 1080,
      height: 1920,
      durationMs: 15_000,
    });
  });

  it("passes a 1080p, on-length, -16 LUFS file", () => {
    expect(deliveryProblems(deliveryOf({ prompt: "x" }), ok, loud)).toEqual([]);
  });

  it("names every miss: size, length, silence, loudness and peak", () => {
    const d = deliveryOf({ prompt: "x" });
    expect(deliveryProblems(d, { ...ok, width: 960, height: 540, durationMs: 11_000 }, loud)).toEqual([
      "size 960x540, expected 1920x1080",
      "duration 11000 ms, expected 10000 +/-500 ms",
    ]);
    expect(deliveryProblems(d, { ...ok, audioCodec: undefined }, undefined)).toEqual(["no audio track"]);
    expect(deliveryProblems(d, ok, { integratedLufs: -Infinity, truePeakDbtp: -Infinity })).toEqual([
      "audio is silent",
    ]);
    expect(deliveryProblems(d, ok, { integratedLufs: -24, truePeakDbtp: -0.2 })).toEqual([
      "loudness -24 LUFS, expected -16 +/-2",
      "true peak -0.2 dBTP, expected <= -1",
    ]);
  });
});

describe("skill-agent run stage reservation", () => {
  const run = skillAgentPipeline.stages({} as never, {} as never)[1] as unknown as {
    estimateCostCents: (s: unknown) => number;
  };
  const estimate = (job: Record<string, unknown>) => run.estimateCostCents({ job: { payload: {}, ...job } });

  it("reserves no more than what is left of the job budget", () => {
    expect(estimate({ budgetCents: 500, spentCents: 1 })).toBe(499);
    expect(estimate({ budgetCents: 5000, spentCents: 0 })).toBe(800);
    expect(estimate({ spentCents: 0 })).toBe(800);
    expect(estimate({ budgetCents: 100, spentCents: 200 })).toBe(0);
  });
});
