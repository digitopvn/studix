import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { measureAudibleSpan } from "../src/ffmpeg/audible-span.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** Writes `lead` s of silence, then `sound` s of a tone (none when 0), then `tail` s of silence. */
function padded(file: string, lead: number, sound: number, tail: number) {
  const parts = [`anullsrc=r=44100:cl=mono:d=${lead}`];
  if (sound > 0) parts.push(`sine=frequency=440:sample_rate=44100:duration=${sound}`);
  parts.push(`anullsrc=r=44100:cl=mono:d=${tail}`);
  const run = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...parts.flatMap((p) => ["-f", "lavfi", "-i", p]),
    "-filter_complex",
    `${parts.map((_, i) => `[${i}]`).join("")}concat=n=${parts.length}:v=0:a=1`,
    file,
  ]);
  if (run.status !== 0) throw new Error(run.stderr.toString());
}

describe.skipIf(!hasFfmpeg)("measuring the audible span of a take with FFmpeg", () => {
  const dir = mkdtempSync(join(tmpdir(), "studix-audible-span-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the sound between leading and trailing silence", async () => {
    const file = join(dir, "take.wav");
    padded(file, 0.2, 1.766, 0.15);
    const span = await measureAudibleSpan(file, {});
    // Within 10 ms: FFmpeg logs lengths in centiseconds.
    expect(Math.abs((span?.durationMs ?? 0) - 2116)).toBeLessThanOrEqual(10);
    expect(Math.abs((span?.startMs ?? 0) - 200)).toBeLessThanOrEqual(10);
    expect(Math.abs((span?.endMs ?? 0) - 1966)).toBeLessThanOrEqual(10);
  });

  it("has no span for a silent take and fails on a file that is not audio", async () => {
    const silent = join(dir, "silent.wav");
    padded(silent, 0.5, 0, 0.5);
    expect(await measureAudibleSpan(silent, {})).toBeUndefined();
    const junk = join(dir, "junk.wav");
    writeFileSync(junk, "not audio");
    await expect(measureAudibleSpan(junk, {})).rejects.toThrow(/silence measurement failed/);
  });
});
