import { describe, expect, it } from "vitest";
import { beatGridOf } from "../src/index.ts";

const RATE = 11_025;

/** Deterministic noise in -1..1 (a fixed LCG), so the tests never flake. */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 2_147_483_648 - 1;
  };
}

/**
 * A click track: decaying 1 kHz clicks every beat from `offsetS`, every 4th one (the downbeat) twice as
 * loud, over a little noise. Returns the samples and the true beat and downbeat times.
 */
function clickTrack(bpm: number, offsetS: number, durationS: number) {
  const samples = new Float32Array(Math.round(durationS * RATE));
  const rand = noise(bpm);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.01 * rand();
  const beatsMs: number[] = [];
  const downbeatsMs: number[] = [];
  for (let k = 0, t = offsetS; t < durationS - 0.1; k++, t = offsetS + (k * 60) / bpm) {
    beatsMs.push(t * 1000);
    if (k % 4 === 0) downbeatsMs.push(t * 1000);
    const amp = k % 4 === 0 ? 0.8 : 0.4;
    const start = Math.round(t * RATE);
    for (let i = 0; i < 0.05 * RATE && start + i < samples.length; i++) {
      samples[start + i]! += amp * Math.exp(-i / (0.01 * RATE)) * Math.sin((2 * Math.PI * 1000 * i) / RATE);
    }
  }
  return { samples, beatsMs, downbeatsMs };
}

/** Largest distance from each true time to the nearest found time. */
function worstMiss(truth: number[], found: number[]): number {
  return Math.max(...truth.map((t) => Math.min(...found.map((f) => Math.abs(f - t)))));
}

describe("beatGridOf", () => {
  it.each([
    [100, 0.37],
    [120, 1.1],
    [128, 0.05],
  ])("finds %d BPM, its beats and its downbeats in a click track", (bpm, offsetS) => {
    const track = clickTrack(bpm, offsetS, 20);
    const grid = beatGridOf(track.samples, RATE);
    expect(grid).toBeDefined();
    expect(Math.abs(grid!.bpm - bpm)).toBeLessThanOrEqual(1.5);
    expect(grid!.beatsMs).toHaveLength(track.beatsMs.length);
    expect(worstMiss(track.beatsMs, grid!.beatsMs)).toBeLessThanOrEqual(30);
    expect(grid!.downbeatsMs).toHaveLength(track.downbeatsMs.length);
    expect(worstMiss(track.downbeatsMs, grid!.downbeatsMs)).toBeLessThanOrEqual(30);
    expect(grid!.confidence).toBeGreaterThan(0.3);
    expect(grid!.beatsMs.every((t, i) => Number.isInteger(t) && (i === 0 || t > grid!.beatsMs[i - 1]!))).toBe(
      true,
    );
  });

  it("finds no grid in silence, in noise or in a clip under 4 s", () => {
    expect(beatGridOf(new Float32Array(10 * RATE), RATE)).toBeUndefined();
    const rand = noise(7);
    expect(
      beatGridOf(
        Float32Array.from({ length: 10 * RATE }, () => 0.3 * rand()),
        RATE,
      ),
    ).toBeUndefined();
    expect(beatGridOf(clickTrack(120, 0, 3.5).samples, RATE)).toBeUndefined();
  });

  it("analyses a minute of audio well under a second", () => {
    const { samples } = clickTrack(124, 0.2, 60);
    const started = performance.now();
    expect(beatGridOf(samples, RATE)?.beatsMs.length).toBeGreaterThan(100);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
