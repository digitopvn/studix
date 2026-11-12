import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeBeats } from "../src/ffmpeg/beat-grid.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("analysing the beats of an audio file with FFmpeg", () => {
  const dir = mkdtempSync(join(tmpdir(), "studix-beats-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the tempo, beats and downbeats of a 120 BPM click track starting at 250 ms", async () => {
    const file = join(dir, "clicks.mp3");
    // A decaying 1 kHz click every 0.5 s from 0.25 s, every 4th one (each 2 s) twice as loud.
    const phase = "mod(t-0.25,0.5)";
    const click = `gte(t,0.25)*lt(${phase},0.05)*sin(2*PI*1000*t)*exp(-${phase}*100)`;
    const accent = "if(lt(mod(t-0.25,2),0.05),0.8,0.4)";
    const run = spawnSync("ffmpeg", [
      ...["-v", "error", "-y", "-f", "lavfi"],
      ...["-i", `aevalsrc='${click}*${accent}':s=44100:d=12`],
      file,
    ]);
    expect(run.status, run.stderr.toString()).toBe(0);

    const grid = await analyzeBeats(file, {});
    expect(grid?.bpm).toBeCloseTo(120, 0);
    const truth = Array.from({ length: 24 }, (_, k) => 250 + 500 * k);
    const near = (found: number[] | undefined, want: number[]) => {
      expect(found).toHaveLength(want.length);
      // Within 30 ms; mp3 adds its encoder delay at the start.
      const misses = (found ?? []).map((t, i) => Math.abs(t - want[i]!));
      expect(Math.max(...misses)).toBeLessThanOrEqual(30);
    };
    near(grid?.beatsMs, truth);
    near(
      grid?.downbeatsMs,
      truth.filter((_, k) => k % 4 === 0),
    );
  });

  it("fails on a file that is not audio", async () => {
    const junk = join(dir, "junk.wav");
    writeFileSync(junk, "not audio");
    await expect(analyzeBeats(junk, {})).rejects.toThrow(/beat analysis decode failed/);
  });
});
