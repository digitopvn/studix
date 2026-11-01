import { describe, expect, it } from "vitest";
import {
  assertHardGate,
  defaultHardChecks,
  evaluateChecks,
  type HardGateReport,
  parseChecks,
  type QaMeasurements,
} from "../src/index.ts";

/** Measurements of a file that meets every default limit. */
const good: QaMeasurements = {
  "probe.hasVideo": 1,
  "probe.hasAudio": 1,
  "probe.durationS": 3,
  "probe.fps": 24,
  "loudness.integratedLufs": -14.3,
  "loudness.truePeakDbtp": -1.6,
  "black.leadingS": 0,
  "black.maxInnerRunS": 0,
  "black.allBlack": 0,
  "sync.audioDelayMs": 0,
  "sync.durationDeltaMs": 10,
};

const failedIds = (m: QaMeasurements, checks = defaultHardChecks({ durationS: 3, fps: 24 })) =>
  evaluateChecks(checks, m)
    .filter((r) => !r.pass)
    .map((r) => r.id);

describe("default hard checks", () => {
  // Values from the source's golden test of the delivery limits (zuey-workspace@10719856:
  // .agents/skills/anime-creator/scripts/tests/test_delivery_and_mix_tools.py, test_problems_name_each_broken_limit).
  it("pass a file inside every limit", () => {
    expect(failedIds(good)).toEqual([]);
  });

  it("block a true peak over -1.5 dBTP", () => {
    expect(failedIds({ ...good, "loudness.truePeakDbtp": -1.4 })).toEqual(["true-peak"]);
    expect(failedIds({ ...good, "loudness.truePeakDbtp": 0.4 })).toEqual(["true-peak"]);
    expect(failedIds({ ...good, "loudness.truePeakDbtp": -1.5 })).toEqual([]);
  });

  it("block loudness outside -14 LUFS +/-1", () => {
    expect(failedIds({ ...good, "loudness.integratedLufs": -11 })).toEqual(["loudness"]);
    expect(failedIds({ ...good, "loudness.integratedLufs": -15.1 })).toEqual(["loudness"]);
    expect(failedIds({ ...good, "loudness.integratedLufs": -13 })).toEqual([]);
    expect(failedIds({ ...good, "loudness.integratedLufs": -15 })).toEqual([]);
  });

  it("name each broken limit", () => {
    expect(failedIds({ ...good, "loudness.integratedLufs": -11, "loudness.truePeakDbtp": 0.4 })).toEqual([
      "loudness",
      "true-peak",
    ]);
  });

  it("fail closed when audio was not measured", () => {
    expect(failedIds({ ...good, "loudness.integratedLufs": null, "loudness.truePeakDbtp": null })).toEqual([
      "loudness",
      "true-peak",
    ]);
    const [result] = evaluateChecks(
      defaultHardChecks().filter((c) => c.id === "true-peak"),
      {},
    );
    expect(result).toMatchObject({
      pass: false,
      value: null,
      message: "loudness.truePeakDbtp was not measured",
    });
  });

  it("block black, sync, duration and fps defects", () => {
    expect(failedIds({ ...good, "black.leadingS": 0.75 })).toEqual(["leading-black"]);
    expect(failedIds({ ...good, "black.maxInnerRunS": 2 })).toEqual(["inner-black"]);
    expect(failedIds({ ...good, "black.allBlack": 1 })).toEqual(["not-all-black"]);
    expect(failedIds({ ...good, "sync.audioDelayMs": 250 })).toEqual(["av-sync"]);
    expect(failedIds({ ...good, "sync.audioDelayMs": -50 })).toEqual(["av-sync"]);
    expect(failedIds({ ...good, "sync.durationDeltaMs": -400 })).toEqual(["av-duration"]);
    expect(failedIds({ ...good, "probe.durationS": 3.5 })).toEqual(["duration"]);
    expect(failedIds({ ...good, "probe.fps": 30 })).toEqual(["fps"]);
    expect(failedIds({ ...good, "probe.hasAudio": 0 })).toContain("has-audio");
  });

  it("leave audio checks out of a silent video and skip duration and fps without expectations", () => {
    const ids = defaultHardChecks({ requireAudio: false }).map((c) => c.id);
    expect(ids).toEqual(["has-video", "not-all-black", "leading-black", "inner-black"]);
    expect(() => defaultHardChecks({ durationS: 0 })).toThrow(RangeError);
  });
});

describe("check contract", () => {
  it("parses pack-declared checks and rejects malformed ones", () => {
    expect(parseChecks([{ id: "tp", layer: "hard", metric: "loudness.truePeakDbtp", max: -1 }])).toHaveLength(
      1,
    );
    expect(() => parseChecks([{ id: "tp", layer: "hard", metric: "loudness.truePeakDbtp" }])).toThrow();
    expect(() => parseChecks([{ id: "x", layer: "hard", metric: "probe.fps", min: 30, max: 24 }])).toThrow();
    expect(() => parseChecks([{ id: "x", layer: "hard", metric: "made.up", max: 1 }])).toThrow();
    expect(() => parseChecks([{ id: "x", layer: "human", metric: "probe.fps", max: 1 }])).toThrow();
  });

  it("assertHardGate blocks with a non-retryable VALIDATION error naming the failures", () => {
    const checks = evaluateChecks(defaultHardChecks(), { ...good, "loudness.truePeakDbtp": -0.4 });
    const failures = checks.filter((c) => !c.pass);
    const report = { pass: false, checks, failures, measurements: {} } as unknown as HardGateReport;
    expect(() => assertHardGate(report)).toThrow(/QA hard gate failed: loudness.truePeakDbtp -0.4 outside/);
    try {
      assertHardGate(report);
    } catch (err) {
      expect(err).toMatchObject({ code: "VALIDATION", retryable: false });
    }
    expect(() => assertHardGate({ ...report, pass: true, failures: [] })).not.toThrow();
  });
});
