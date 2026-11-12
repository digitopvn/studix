import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type RunFfmpegOptions, runFfmpeg } from "./run-process.ts";

/** Beat grid of a music bed, in integer ms from the start of the file. */
export interface MusicBeats {
  bpm: number;
  /** Every beat, ascending, covering the whole analysed audio. */
  beatsMs: number[];
  /** Every 4th beat: the bar starts. */
  downbeatsMs: number[];
}

const DEFAULT_BPM_RANGE: readonly [number, number] = [70, 180];
/** Onset envelope rate: 10 ms frames resolve a beat well inside what a cut can show. */
const ENVELOPE_FPS = 100;
/** Below this peak level (about -80 dBFS) the signal counts as silent. */
const SILENCE_PEAK = 1e-4;
/** Smallest mean autocorrelation at the beat period (relative to lag 0) that still counts as a pulse. */
const MIN_PULSE = 0.1;
/** Periodicities checked per tempo candidate: the beat and its next three multiples. */
const HARMONICS = 4;
const BEATS_PER_BAR = 4;
/** Decode rate for analysis: plenty for kick and snare transients, and small in memory. */
const ANALYSIS_RATE = 11_025;
/** Longest stretch analysed, which bounds memory (about 26 MB of samples) and time. */
const MAX_ANALYSIS_S = 600;

/** Value of `xs` at a fractional index, linearly interpolated; 0 outside. */
function at(xs: Float64Array, i: number): number {
  if (!(i >= 0 && i <= xs.length - 1)) return 0;
  const lo = Math.floor(i);
  if (lo === xs.length - 1) return xs[lo]!;
  const f = i - lo;
  return xs[lo]! * (1 - f) + xs[lo + 1]! * f;
}

/**
 * Onset strength per frame: the rise of log-compressed frame energy (compressed relative to the loudest
 * frame, so quiet passages do not amplify noise), half-wave rectified.
 */
function onsetEnvelope(samples: Float32Array, hop: number): Float64Array {
  const frames = Math.floor(samples.length / hop);
  const power = new Float64Array(frames);
  let maxPower = 0;
  for (let n = 0; n < frames; n++) {
    let sum = 0;
    for (let j = n * hop; j < (n + 1) * hop; j++) sum += samples[j]! * samples[j]!;
    power[n] = sum / hop;
    if (power[n]! > maxPower) maxPower = power[n]!;
  }
  const onset = new Float64Array(frames);
  let prev = 0;
  for (let n = 0; n < frames; n++) {
    const level = Math.log1p((1000 * power[n]!) / maxPower);
    onset[n] = Math.max(0, level - prev);
    prev = level;
  }
  return onset;
}

/** Autocorrelation of the mean-removed envelope for lags 0..maxLag, normalised so lag 0 is 1. */
function autocorrelation(env: Float64Array, maxLag: number): Float64Array {
  let mean = 0;
  for (const x of env) mean += x;
  mean /= env.length;
  const centred = env.map((x) => x - mean);
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < centred.length; lag++) {
    let sum = 0;
    for (let n = lag; n < centred.length; n++) sum += centred[n]! * centred[n - lag]!;
    ac[lag] = sum;
  }
  const zero = ac[0]!;
  return zero > 0 ? ac.map((x) => x / zero) : ac;
}

/** Sum of the envelope on the comb `phase + k × period` over the whole envelope. */
function combScore(env: Float64Array, period: number, phase: number): number {
  let sum = 0;
  for (let t = phase; t < env.length; t += period) sum += at(env, t);
  return sum;
}

/**
 * Pure: onset-strength envelope -> tempo by autocorrelation within bpmRange (allow octave folding into the
 * range), beat phase by best comb alignment, downbeats = every 4th beat with the phase whose beats carry the
 * most onset energy. Undefined when the signal is silent or has no clear pulse.
 *
 * The tempo is taken as constant over the file (a produced music bed is), so the grid is one period and
 * one phase fitted to the whole envelope; that also makes it precise to a fraction of a frame.
 */
export function detectBeats(
  samples: Float32Array,
  sampleRate: number,
  options?: { bpmRange?: readonly [number, number] },
): MusicBeats | undefined {
  const [minBpm, maxBpm] = options?.bpmRange ?? DEFAULT_BPM_RANGE;
  if (!(sampleRate > 0) || !(minBpm > 0) || !(maxBpm > minBpm)) return undefined;
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  if (!(peak >= SILENCE_PEAK)) return undefined;

  const hop = Math.max(1, Math.round(sampleRate / ENVELOPE_FPS));
  const fps = sampleRate / hop;
  const env = onsetEnvelope(samples, hop);
  const periodOf = (bpm: number) => (60 * fps) / bpm;
  // At least two beats at the slowest tempo, or there is nothing to correlate.
  if (env.length < 2 * periodOf(minBpm)) return undefined;

  // Tempo: the in-range period whose multiples correlate best. Scoring only in-range candidates folds a
  // half- or double-time pulse into the range.
  const ac = autocorrelation(env, Math.ceil(HARMONICS * periodOf(minBpm)) + 1);
  let coarse = minBpm;
  let best = -Infinity;
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.25) {
    let score = 0;
    for (let k = 1; k <= HARMONICS; k++) score += at(ac, k * periodOf(bpm));
    if (score > best) [best, coarse] = [score, bpm];
  }
  if (at(ac, periodOf(coarse)) < MIN_PULSE) return undefined;

  // Period and phase: the comb that lands on the most onset energy across the whole file.
  const smooth = env.map((x, n) => 0.5 * x + 0.25 * ((env[n - 1] ?? 0) + (env[n + 1] ?? 0)));
  let period = periodOf(coarse);
  let phase = 0;
  best = -Infinity;
  const centre = periodOf(coarse);
  for (let p = centre * 0.97; p <= centre * 1.03; p += centre * 0.001) {
    const bpm = (60 * fps) / p;
    if (bpm < minBpm || bpm > maxBpm) continue;
    for (let phi = 0; phi < p; phi += 0.25) {
      const score = combScore(smooth, p, phi);
      if (score > best) [best, period, phase] = [score, p, phi];
    }
  }

  // A beat's onset lies somewhere inside its frame; the frame centre is the unbiased time.
  const msOf = (frame: number) => Math.round(((frame + 0.5) * 1000) / fps);
  const endMs = (samples.length / sampleRate) * 1000;
  // The best phase may sit a period late when the first beat lands just before frame 0's centre.
  let first = phase;
  while (first - period + 0.5 >= 0) first -= period;
  const frames: number[] = [];
  for (let t = first; msOf(t) <= endMs; t += period) frames.push(t);
  const beatsMs = frames.map(msOf);

  const strength = (t: number) => {
    let max = 0;
    for (let n = Math.round(t) - 2; n <= Math.round(t) + 2; n++) max = Math.max(max, env[n] ?? 0);
    return max;
  };
  const barEnergy = new Array<number>(BEATS_PER_BAR).fill(0);
  frames.forEach((t, i) => {
    barEnergy[i % BEATS_PER_BAR]! += strength(t);
  });
  const downbeatPhase = barEnergy.indexOf(Math.max(...barEnergy));
  return {
    bpm: Math.round(((60 * fps) / period) * 100) / 100,
    beatsMs,
    downbeatsMs: beatsMs.filter((_, i) => i % BEATS_PER_BAR === downbeatPhase),
  };
}

/**
 * Decode the first audio stream to mono f32le at a low rate (e.g. 11025 Hz) with ffmpeg and run
 * detectBeats. Throws when ffmpeg cannot read the file.
 *
 * At most the first 10 minutes are analysed, which bounds memory; the raw samples go through a private
 * temp directory that is always removed.
 */
export async function analyseMusicBeats(
  file: string,
  options: RunFfmpegOptions & { bpmRange?: readonly [number, number] },
): Promise<MusicBeats | undefined> {
  const { bpmRange, ...run } = options;
  const dir = await mkdtemp(join(tmpdir(), "studix-beats-"));
  try {
    const raw = join(dir, "mono.f32");
    await runFfmpeg(
      "music beat decode",
      [
        ...["-i", resolve(file), "-map", "0:a:0", "-t", String(MAX_ANALYSIS_S)],
        ...["-ac", "1", "-ar", String(ANALYSIS_RATE), "-f", "f32le", "-y", raw],
      ],
      { ...run, timeoutMs: run.timeoutMs ?? 60_000 },
    );
    const bytes = await readFile(raw);
    const length = Math.floor(bytes.byteLength / 4);
    // A Float32Array view needs a 4-byte aligned offset; copy in the rare case the buffer is not.
    const samples =
      bytes.byteOffset % 4 === 0
        ? new Float32Array(bytes.buffer, bytes.byteOffset, length)
        : new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + length * 4));
    return detectBeats(samples, ANALYSIS_RATE, bpmRange ? { bpmRange } : undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
