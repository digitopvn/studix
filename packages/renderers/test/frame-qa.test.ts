import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFrames, frameProblems, sampleTimesMs, writeContactSheet } from "../src/ffmpeg/frame-qa.ts";

const W = 160;
const H = 90;
const flat = (v: number) => new Uint8Array(W * H).fill(v);
/** A flat frame with a white box covering the given pixel rectangle. */
function withBox(bg: number, x0: number, y0: number, x1: number, y1: number) {
  const f = flat(bg);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) f[y * W + x] = 255;
  return f;
}

describe("frame problems", () => {
  const t = [1000, 2000];
  it("accepts a centred graphic and names black, blank and margin faults", () => {
    const good = withBox(20, 40, 30, 120, 60);
    expect(frameProblems(t, [good, good], {}).problems).toEqual([]);
    expect(frameProblems(t, [flat(0), good], {}).problems).toEqual(["black frame at 1.0s"]);
    expect(frameProblems(t, [good, flat(120)], {}).problems[0]).toMatch(/^blank frame at 2.0s/);
    const edge = withBox(20, 0, 30, 60, 60);
    expect(frameProblems(t, [edge, good], { safeMarginPct: 5 }).problems[0]).toMatch(
      /inside the 5% safe margin at 1.0s and touching the frame edge/,
    );
    expect(frameProblems(t, [good, good], { safeMarginPct: 5 }).problems).toEqual([]);
  });

  it("reports samples that do not change only when motion is requested", () => {
    const a = withBox(20, 40, 30, 120, 60);
    const b = withBox(20, 50, 30, 130, 60);
    expect(frameProblems(t, [a, a], {}).problems).toEqual([]);
    expect(frameProblems(t, [a, a], { motion: true }).problems).toEqual([
      "no visible change between 1.0s and 2.0s",
    ]);
    expect(frameProblems(t, [a, b], { motion: true }).problems).toEqual([]);
  });

  it("spaces samples inside the video", () => {
    expect(sampleTimesMs(6000, 2)).toEqual([2000, 4000]);
  });
});

describe("real frames", () => {
  it("flags a black render and writes a contact sheet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frame-qa-"));
    try {
      const black = join(dir, "black.mp4");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x180:d=3:r=10",
        "-y",
        black,
      ]);
      const seen = await checkFrames(black, 3000, { samples: 3, workDir: join(dir, "w") });
      expect(seen.problems).toHaveLength(3);
      const moving = join(dir, "moving.mp4");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:d=3:r=10",
        "-y",
        moving,
      ]);
      const ok = await checkFrames(moving, 3000, { samples: 3, motion: true, workDir: join(dir, "w") });
      expect(ok.problems).toEqual([]);
      const bytes = await writeContactSheet(moving, 3000, 3, join(dir, "sheet.jpg"), {
        workDir: join(dir, "w"),
      });
      expect(bytes).toBeGreaterThan(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
