import { mergeManifest } from "@studix/core";
import { describe, expect, it } from "vitest";
import { compositionCheckProblems } from "../src/composition-runner.ts";

const file = (path: string) => ({ path, bytes: 1, sha256: "x", contentType: "text/plain" });

describe("composition runs", () => {
  it("lists every way a render misses its output check", () => {
    const check = {
      path: "out/v.mp4",
      width: 1920,
      height: 1080,
      durationMs: 10_000,
      durationToleranceMs: 500,
    };
    expect(
      compositionCheckProblems(check, { width: 1920, height: 1080, durationMs: 10_200 }, undefined),
    ).toEqual([]);
    const problems = compositionCheckProblems(
      { ...check, loudnessLufs: -16 },
      { width: 1280, height: 720, durationMs: 12_000, audioCodec: "aac" },
      { integratedLufs: -23, truePeakDbtp: 0 } as never,
    );
    expect(problems).toHaveLength(5);
  });

  it("requires an audible track when audio is requested", () => {
    const check = { path: "out/v.mp4", durationToleranceMs: 500, audio: true };
    const probe = { width: 1920, height: 1080, durationMs: 1000 };
    expect(compositionCheckProblems(check, probe, undefined)).toEqual(["no audio track"]);
    expect(compositionCheckProblems(check, { ...probe, audioCodec: "aac" }, undefined)).toEqual([
      "audio is silent",
    ]);
    expect(
      compositionCheckProblems(
        check,
        { ...probe, audioCodec: "aac" },
        { integratedLufs: -18, truePeakDbtp: -3 },
      ),
    ).toEqual([]);
  });

  it("merges run output into the manifest, keeping files written meanwhile", () => {
    const manifest = { id: "cmp_1", files: [file("index.html"), file("old.png")] } as never;
    const merged = mergeManifest(manifest, [file("out/video.mp4")], ["old.png"]);
    expect(merged.files.map((f) => f.path).sort()).toEqual(["index.html", "out/video.mp4"]);
  });
});
