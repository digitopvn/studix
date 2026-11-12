import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { StudixError } from "@studix/shared";

/** Where the beats of a piece of music fall, on the source's own timeline. */
export interface BeatGrid {
  /** Tempo fitted through the beats. */
  bpm: number;
  /** Beat times in ms from the start of the source, ascending integers. */
  beatsMs: number[];
  /** The first beat of every bar (every 4th beat), a subset of `beatsMs`. */
  downbeatsMs: number[];
  /** 0..1: how periodic the onsets are at this tempo; near 0 means the grid is a guess. */
  confidence: number;
}

/** Decode rate for analysis: plenty for onsets, and a 60 s file stays under 3 MB of samples. */
const ANALYSIS_RATE = 11_025;
/** Onset envelope step. */
const HOP_S = 0.01;
const MIN_DURATION_S = 4;
const MIN_BPM = 70;
const MAX_BPM = 180;
const BPM_STEP = 0.05;
/** The tempo prior: a log-normal around 120 BPM, this many octaves wide (mild). */
const PRIOR_BPM = 120;
const PRIOR_OCTAVES = 1;
/** Multiples of the beat period that vote for a tempo. */
const COMB_TAPS = 4;
/** Each grid beat moves to the strongest onset this close to it. */
const SNAP_S = 0.04;
/** A grid less periodic than this is no grid. */
const MIN_CONFIDENCE = 0.1;
/** Peak level below which the source counts as silent. */
const SILENT_PEAK = 1e-4;
/** Leading and trailing beats whose onset is under this share of the median beat's lie outside the music. */
const WEAK_BEAT = 0.3;
const BEATS_PER_BAR = 4;
/** Longest stretch decoded for analysis. */
const MAX_ANALYSIS_S = 600;

/**
 * Per-frame onset strength: the half-wave rectified rise in log energy, summed over the full band and a
 * high-passed band (a two-band spectral flux), so both kicks and hats register.
 */
function onsetEnvelope(samples: Float32Array, hop: number): Float64Array {
  const frames = Math.floor((samples.length - 2 * hop) / hop) + 1;
  const energy = new Float64Array(frames);
  const high = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let full = 0;
    let hp = 0;
    const from = f * hop;
    for (let i = from; i < from + 2 * hop; i++) {
      const x = samples[i] ?? 0;
      const d = x - (samples[i - 1] ?? 0);
      full += x * x;
      hp += d * d;
    }
    energy[f] = full;
    high[f] = hp;
  }
  const floorOf = (e: Float64Array) => {
    let sum = 0;
    for (const v of e) sum += v;
    return (sum / e.length) * 1e-3 + 1e-12;
  };
  const fullFloor = floorOf(energy);
  const highFloor = floorOf(high);
  const onset = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    const rise =
      Math.max(0, Math.log((energy[f]! + fullFloor) / (energy[f - 1]! + fullFloor))) +
      Math.max(0, Math.log((high[f]! + highFloor) / (high[f - 1]! + highFloor)));
    onset[f] = rise;
  }
  return onset;
}

/** Autocorrelation of the mean-removed envelope for lags 0..maxLag, normalised per overlapping frame. */
function autocorrelation(onset: Float64Array, maxLag: number): Float64Array {
  let mean = 0;
  for (const v of onset) mean += v;
  mean /= onset.length;
  const centred = onset.map((v) => v - mean);
  const r = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < centred.length; i++) sum += centred[i]! * centred[i + lag]!;
    r[lag] = sum / (centred.length - lag);
  }
  return r;
}

const at = (values: Float64Array, x: number): number => {
  const i = Math.floor(x);
  const frac = x - i;
  return (values[i] ?? 0) * (1 - frac) + (values[i + 1] ?? 0) * frac;
};

/** Beat period in frames that best fits the envelope, with how periodic it is (0..1). */
function tempoOf(onset: Float64Array, framesPerS: number): { period: number; confidence: number } {
  const maxLag = Math.ceil(((framesPerS * 60) / MIN_BPM) * COMB_TAPS);
  const r = autocorrelation(onset, maxLag);
  const r0 = r[0]!;
  if (!(r0 > 0)) return { period: 0, confidence: 0 };
  let best = { period: 0, score: Number.NEGATIVE_INFINITY, comb: 0 };
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += BPM_STEP) {
    const period = (framesPerS * 60) / bpm;
    let comb = 0;
    for (let k = 1; k <= COMB_TAPS; k++) comb += at(r, period * k);
    comb /= COMB_TAPS * r0;
    const octaves = Math.log2(bpm / PRIOR_BPM) / PRIOR_OCTAVES;
    const score = comb * Math.exp(-0.5 * octaves * octaves);
    if (score > best.score) best = { period, score, comb };
  }
  return { period: best.period, confidence: Math.min(1, Math.max(0, best.comb)) };
}

/** The envelope spread over ±`radius` frames (triangular), so the phase search tolerates small drift. */
function smoothed(onset: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(onset.length);
  for (let i = 0; i < onset.length; i++) {
    let sum = 0;
    for (let d = -radius; d <= radius; d++) sum += (onset[i + d] ?? 0) * (radius + 1 - Math.abs(d));
    out[i] = sum;
  }
  return out;
}

/**
 * The beat grid of mono PCM `samples` (any rate): tempo by autocorrelation of an onset envelope (70-180
 * BPM, mildly preferring 120), beat phase where the onsets line up best, each beat snapped to the
 * strongest onset within 40 ms, and the bar phase where the beats hit hardest. A lead-in or tail without
 * onsets on the beat gets no beats. Undefined for silence, under 4 s of audio, or no clear period.
 */
export function beatGridOf(samples: Float32Array, sampleRate: number): BeatGrid | undefined {
  if (!(sampleRate > 0) || samples.length < MIN_DURATION_S * sampleRate) return undefined;
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  if (!(peak >= SILENT_PEAK)) return undefined;

  const hop = Math.max(1, Math.round(sampleRate * HOP_S));
  const framesPerS = sampleRate / hop;
  const onset = onsetEnvelope(samples, hop);
  const { period, confidence } = tempoOf(onset, framesPerS);
  if (period <= 0 || confidence < MIN_CONFIDENCE) return undefined;

  // Phase: the offset whose comb of beats collects the most onset strength.
  const spread = smoothed(onset, 2);
  let phase = 0;
  let phaseScore = Number.NEGATIVE_INFINITY;
  for (let p = 0; p < period; p += 0.25) {
    let sum = 0;
    for (let t = p; t < spread.length; t += period) sum += spread[Math.round(t)] ?? 0;
    if (sum > phaseScore) {
      phaseScore = sum;
      phase = p;
    }
  }

  const snap = Math.round(SNAP_S * framesPerS);
  const beats: Array<{ frame: number; strength: number }> = [];
  for (let t = phase; t < onset.length; t += period) {
    const centre = Math.round(t);
    let frame = centre;
    let strength = onset[centre] ?? 0;
    for (let f = Math.max(0, centre - snap); f <= Math.min(onset.length - 1, centre + snap); f++) {
      if (onset[f]! > strength) {
        strength = onset[f]!;
        frame = f;
      }
    }
    if (beats.length === 0 || frame > beats.at(-1)!.frame) beats.push({ frame, strength });
  }
  // The grid spans the whole file; drop the beats of a lead-in or tail that has no onsets on them.
  const median = [...beats].map((b) => b.strength).sort((a, b) => a - b)[Math.floor(beats.length / 2)] ?? 0;
  const strong = (b: { strength: number }) => b.strength >= WEAK_BEAT * median;
  beats.splice(beats.findLastIndex(strong) + 1);
  beats.splice(0, Math.max(0, beats.findIndex(strong)));
  if (beats.length < BEATS_PER_BAR) return undefined;

  // An onset rises in the first frame whose window reaches it, which starts one hop before the frame's
  // midpoint: the frame start plus one hop is where the sound begins.
  const beatsMs = beats.map((b) => Math.round(((b.frame + 1.5) * hop * 1000) / sampleRate));
  const bar = Array.from({ length: BEATS_PER_BAR }, (_, offset) => {
    const on = beats.filter((_, i) => i % BEATS_PER_BAR === offset);
    return on.reduce((sum, b) => sum + b.strength, 0) / on.length;
  });
  const downbeat = bar.indexOf(Math.max(...bar));
  const downbeatsMs = beatsMs.filter((_, i) => i % BEATS_PER_BAR === downbeat);

  // Tempo from a least-squares line through the beats, finer than the search step.
  const n = beatsMs.length;
  const meanI = (n - 1) / 2;
  const meanT = beatsMs.reduce((s, t) => s + t, 0) / n;
  let num = 0;
  let den = 0;
  beatsMs.forEach((t, i) => {
    num += (i - meanI) * (t - meanT);
    den += (i - meanI) ** 2;
  });
  const bpm = Math.round((60_000 / (num / den)) * 100) / 100;
  return { bpm, beatsMs, downbeatsMs, confidence: Math.round(confidence * 1000) / 1000 };
}

/** Only what ffmpeg needs; credentials in the worker environment never reach it. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** First audio stream of `file` as mono float samples at `rate` (at most the first 10 minutes). */
function decodeMono(
  file: string,
  rate: number,
  options: { ffmpegPath?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<Float32Array> {
  const bin = options.ffmpegPath ?? "ffmpeg";
  const args = [
    ...["-nostdin", "-hide_banner", "-nostats", "-v", "error", "-i", resolve(file)],
    ...["-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(rate), "-t", String(MAX_ANALYSIS_S)],
    ...["-f", "f32le", "pipe:1"],
  ];
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new StudixError("CANCELLED", "beat analysis cancelled before start"));
      return;
    }
    const child = spawn(bin, args, { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2000).unref();
    };
    const onAbort = () => {
      kill();
      finish(() => reject(new StudixError("CANCELLED", "beat analysis cancelled")));
    };
    const timeoutMs = options.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new StudixError("TIMEOUT", `beat analysis timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          err.code === "ENOENT"
            ? new StudixError("UNAVAILABLE", `${bin} is not installed or not on PATH`, {
                cause: err,
                retryable: false,
                suggestedAction: "Install FFmpeg (ffmpeg + ffprobe) or set FFMPEG_PATH / FFPROBE_PATH.",
              })
            : new StudixError("INTERNAL", `Failed to start ${bin}: ${err.message}`, { cause: err }),
        ),
      );
    });
    child.on("close", (code) =>
      finish(() => {
        if (code !== 0) {
          reject(
            new StudixError("INTERNAL", `ffmpeg beat analysis decode failed (exit ${code ?? -1})`, {
              details: { stderr: stderr.slice(-2000) },
            }),
          );
          return;
        }
        const bytes = Buffer.concat(chunks);
        const usable = bytes.byteLength - (bytes.byteLength % 4);
        // Copy into a fresh, 4-byte aligned buffer: pooled Buffers may start at any offset.
        resolvePromise(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usable)));
      }),
    );
  });
}

/**
 * Beat grid of the first audio stream of `filePath`, decoded locally by ffmpeg (no paid call). Throws when
 * ffmpeg cannot read the file; resolves undefined when the audio has no clear beat (see `beatGridOf`).
 */
export async function analyzeBeats(
  filePath: string,
  options: { ffmpegPath?: string; signal?: AbortSignal },
): Promise<BeatGrid | undefined> {
  const samples = await decodeMono(filePath, ANALYSIS_RATE, options);
  return beatGridOf(samples, ANALYSIS_RATE);
}
