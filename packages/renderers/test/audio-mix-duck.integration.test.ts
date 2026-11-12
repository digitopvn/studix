import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoIR } from "@studix/video-ir";
import { afterAll, describe, expect, it } from "vitest";
import { type AudioSourceInfo, mixAudio, planAudioClips } from "../src/ffmpeg/audio-mix.ts";
import { loadIrFixture } from "./render-test-helpers.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const RATE = 8000;

/** The file decoded to mono float samples at 8 kHz. */
function samplesOf(file: string): Float32Array {
  const run = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-ar", String(RATE), "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status !== 0) throw new Error(run.stderr.toString());
  const bytes = run.stdout;
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** RMS level in dBFS between two times in seconds. */
function levelDb(samples: Float32Array, fromS: number, toS: number): number {
  let sum = 0;
  const from = Math.round(fromS * RATE);
  const to = Math.round(toS * RATE);
  for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2;
  return 10 * Math.log10(sum / (to - from));
}

describe.skipIf(!hasFfmpeg)("music ducked under speech in the FFmpeg mix", () => {
  const dir = mkdtempSync(join(tmpdir(), "studix-duck-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("dips the music by duckDb while the voice-over plays and brings it back after", async () => {
    const music = join(dir, "music.wav");
    const voice = join(dir, "voice.wav");
    // A silent voice-over keeps the measured level purely the music's.
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", music]);
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=3", voice]);

    const ir: VideoIR = structuredClone(loadIrFixture("product-promo-16x9-assets"));
    ir.assets.push({ ...ir.assets[0]!, id: "voice" });
    ir.audio = [
      { id: "bed", kind: "music", assetId: "music", startMs: 500, volume: 1, duckDb: -20 },
      { id: "vo-1", kind: "voiceover", assetId: "voice", startMs: 2000, durationMs: 1000, volume: 1 },
      // 300 ms after the first line: closer than attack + release, so one dip covers both.
      { id: "vo-2", kind: "voiceover", assetId: "voice", startMs: 3300, durationMs: 700, volume: 1 },
    ];
    const sources = new Map<string, AudioSourceInfo>([
      [music, { hasAudio: true, durationMs: 8000 }],
      [voice, { hasAudio: true, durationMs: 3000 }],
    ]);
    const clips = planAudioClips(ir, { music, voice }, sources);
    expect(clips[0]?.duck).toEqual({ gain: expect.closeTo(0.1, 6), spans: [{ startMs: 1500, endMs: 3500 }] });
    expect(clips[1]?.duck).toBeUndefined();

    const out = join(dir, "mix.wav");
    await mixAudio(clips, 8000, out, {});
    const samples = samplesOf(out);

    const full = levelDb(samples, 0.8, 1.7);
    expect(levelDb(samples, 2.05, 3.95)).toBeCloseTo(full - 20, 0);
    // Halfway down the attack and halfway up the release.
    expect(levelDb(samples, 1.915, 1.935)).toBeLessThan(full - 3);
    expect(levelDb(samples, 1.915, 1.935)).toBeGreaterThan(full - 12);
    expect(levelDb(samples, 4.165, 4.185)).toBeLessThan(full - 3);
    expect(levelDb(samples, 4.165, 4.185)).toBeGreaterThan(full - 12);
    expect(levelDb(samples, 4.5, 7.5)).toBeCloseTo(full, 0);
  }, 60_000);
});
