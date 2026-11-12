import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyseMusicBeats, detectBeats } from "../src/ffmpeg/music-beats.ts";

const RATE = 11_025;

/** Deterministic noise in [-1, 1), so the synthetic tracks are identical on every run. */
function noise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

/**
 * A kick track: a decaying 60 Hz thump on every beat, louder on each bar's first beat, over a low noise
 * bed. The first beat sits at `offsetMs`, so the first downbeat is not at zero.
 */
function kickTrack(bpm: number, seconds: number, offsetMs: number): Float32Array {
  const out = new Float32Array(seconds * RATE);
  const rand = noise(7);
  for (let i = 0; i < out.length; i++) out[i] = 0.02 * rand();
  const periodMs = 60_000 / bpm;
  for (let k = 0; offsetMs + k * periodMs < seconds * 1000; k++) {
    const start = Math.round(((offsetMs + k * periodMs) / 1000) * RATE);
    const gain = k % 4 === 0 ? 0.9 : 0.45;
    for (let j = 0; j < 0.12 * RATE && start + j < out.length; j++) {
      out[start + j]! += gain * Math.exp(-j / (0.03 * RATE)) * Math.sin((2 * Math.PI * 60 * j) / RATE);
    }
  }
  return out;
}

function expectGrid(bpm: number, offsetMs: number, seconds: number) {
  const beats = detectBeats(kickTrack(bpm, seconds, offsetMs), RATE);
  expect(beats).toBeDefined();
  expect(Math.abs(beats!.bpm - bpm)).toBeLessThanOrEqual(2);
  const barMs = (4 * 60_000) / bpm;
  const truth = Array.from({ length: Math.floor((seconds * 1000 - offsetMs) / barMs) + 1 }, (_, k) =>
    Math.round(offsetMs + k * barMs),
  );
  expect(beats!.downbeatsMs).toHaveLength(truth.length);
  beats!.downbeatsMs.forEach((ms, i) => {
    expect(Math.abs(ms - truth[i]!)).toBeLessThanOrEqual(30);
  });
  expect(beats!.beatsMs).toEqual([...beats!.beatsMs].sort((a, b) => a - b));
  expect(beats!.beatsMs.at(-1)).toBeGreaterThan(seconds * 1000 - 60_000 / bpm - 30);
}

describe("detectBeats", () => {
  it("finds a 120 BPM grid and its accented downbeats", () => {
    expectGrid(120, 250, 16);
  });

  it("finds a 96 BPM grid whose first downbeat comes late", () => {
    expectGrid(96, 400, 20);
  });

  it("returns undefined for silence", () => {
    expect(detectBeats(new Float32Array(10 * RATE), RATE)).toBeUndefined();
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("analyseMusicBeats", () => {
  const dir = mkdtempSync(join(tmpdir(), "studix-beats-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("decodes a file with ffmpeg and throws on one it cannot read", async () => {
    // A 2 Hz pulse train (120 BPM) of short 220 Hz tones.
    const file = join(dir, "pulse.wav");
    const expr = "if(lt(mod(t,0.5),0.05),sin(2*PI*220*t),0)";
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${expr}':d=8:s=44100`, file]);
    const beats = await analyseMusicBeats(file, {});
    expect(Math.abs(beats!.bpm - 120)).toBeLessThanOrEqual(2);
    expect(Math.abs(beats!.beatsMs[0]!)).toBeLessThanOrEqual(30);
    await expect(analyseMusicBeats(join(dir, "missing.wav"), {})).rejects.toThrow(/music beat decode/);
  });
});
