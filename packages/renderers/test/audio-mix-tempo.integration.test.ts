import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type AudioClip, mixAudio } from "../src/ffmpeg/audio-mix.ts";

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

/** Seconds of the file, from ffprobe. */
function lengthOf(file: string): number {
  const out = spawnSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  return Number(out.stdout.toString().trim());
}

/** [start, end] of each stretch of sound, from silencedetect. */
function soundSpans(file: string, totalS: number): Array<[number, number]> {
  const run = spawnSync("ffmpeg", ["-i", file, "-af", "silencedetect=n=-50dB:d=0.1", "-f", "null", "-"]);
  const log = run.stderr.toString();
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const spans: Array<[number, number]> = [];
  let soundFrom = 0;
  starts.forEach((start, i) => {
    if (start > soundFrom + 0.01) spans.push([soundFrom, start]);
    soundFrom = ends[i] ?? totalS;
  });
  if (soundFrom < totalS - 0.01) spans.push([soundFrom, totalS]);
  return spans;
}

describe.skipIf(!hasFfmpeg)("sped-up audio in the FFmpeg mix", () => {
  const dir = mkdtempSync(join(tmpdir(), "studix-tempo-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the full mix length and places a delayed, sped-up take inside its room", async () => {
    const take = join(dir, "take.wav");
    const hit = join(dir, "hit.wav");
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3.161",
      take,
    ]);
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=1", hit]);
    const base = { trimStartMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0 };
    const clips: AudioClip[] = [
      { ...base, id: "vo", kind: "voiceover", file: take, startMs: 1000, durationMs: 2900, rate: 1.09 },
      { ...base, id: "sfx", kind: "sfx", file: hit, startMs: 5000, durationMs: 1000 },
    ];
    const out = join(dir, "mix.wav");
    await mixAudio(clips, 8000, out, {});

    expect(lengthOf(out)).toBeCloseTo(8, 2);
    const spans = soundSpans(out, 8);
    expect(spans).toHaveLength(2);
    expect(spans[0]![0]).toBeCloseTo(1, 1);
    expect(spans[0]![1]).toBeCloseTo(3.9, 1);
    expect(spans[1]![0]).toBeCloseTo(5, 1);
    expect(spans[1]![1]).toBeCloseTo(6, 1);
  }, 60_000);
});

describe.skipIf(!hasFfmpeg)("music ducking in the FFmpeg mix", () => {
  const dir = mkdtempSync(join(tmpdir(), "studix-duck-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("lowers a delayed music bed by its duckDb while a voice-over plays, then recovers", async () => {
    const bed = join(dir, "bed.wav");
    const quiet = join(dir, "quiet.wav");
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=6", bed]);
    // A silent voice-over, so the mix carries only the bed and its level reads the ducking directly.
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono",
      "-t",
      "2",
      quiet,
    ]);
    const base = { trimStartMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0 };
    const clips: AudioClip[] = [
      { ...base, id: "bed", kind: "music", file: bed, startMs: 500, durationMs: 5500, duckDb: -12 },
      { ...base, id: "vo", kind: "voiceover", file: quiet, startMs: 2500, durationMs: 2000 },
    ];
    const out = join(dir, "mix.wav");
    await mixAudio(clips, 6000, out, {});
    const pcm = join(dir, "mix.f32");
    spawnSync("ffmpeg", ["-v", "error", "-y", "-i", out, "-ac", "1", "-ar", "8000", "-f", "f32le", pcm]);
    const raw = readFileSync(pcm);
    const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const db = (fromS: number, toS: number) => {
      const part = samples.subarray(fromS * 8000, toS * 8000);
      return 10 * Math.log10(part.reduce((sum, x) => sum + x * x, 0) / part.length);
    };
    const open = db(1, 2);
    expect(db(3, 4) - open).toBeCloseTo(-12, 0);
    expect(db(5.2, 5.8) - open).toBeCloseTo(0, 0);
  }, 60_000);
});
