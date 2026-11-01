import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StudixError } from "@studix/shared";
import { MIX_SAMPLE_RATE } from "./audio-mix.ts";
import { type RunFfmpegOptions, runFfmpeg } from "./run-process.ts";

/** Delivery loudness: -14 LUFS integrated (+/-1 LU) with true peak at or under -1.5 dBTP. */
export const LOUDNESS_TARGET = { integratedLufs: -14, toleranceLu: 1, truePeakDbtp: -1.5 } as const;

/**
 * loudnorm aims 0.5 dB under the ceiling: AAC encoding adds inter-sample overshoot, which the delivery
 * limiter catches only when the normalised mix already leaves room.
 */
const NORMALIZE_TP = LOUDNESS_TARGET.truePeakDbtp - 0.5;
const NORMALIZE_LRA = 11;

export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDbtp: number;
}

/** loudnorm's analysis block (print_format=json): measured input values and the offset for pass two. */
export interface LoudnormAnalysis extends LoudnessMeasurement {
  lra: number;
  threshold: number;
  targetOffset: number;
}

/** Parse the JSON block loudnorm prints at the end of stderr. */
export function parseLoudnormJson(stderr: string): LoudnormAnalysis {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  let data: Record<string, string>;
  try {
    data = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  } catch (err) {
    throw new StudixError("INTERNAL", "loudnorm printed no measurement", {
      cause: err,
      details: { stderr: stderr.slice(-1000) },
    });
  }
  return {
    integratedLufs: Number(data.input_i),
    truePeakDbtp: Number(data.input_tp),
    lra: Number(data.input_lra),
    threshold: Number(data.input_thresh),
    targetOffset: Number(data.target_offset),
  };
}

const loudnormTarget = `I=${LOUDNESS_TARGET.integratedLufs}:TP=${NORMALIZE_TP}:LRA=${NORMALIZE_LRA}`;

/**
 * Measure a file's first audio stream with a loudnorm analysis pass (integrated loudness, true peak).
 * Silence measures as -Infinity.
 */
export async function measureLoudness(file: string, options: RunFfmpegOptions): Promise<LoudnormAnalysis> {
  const stderr = await runFfmpeg(
    "loudness measurement",
    [
      "-i",
      resolve(file),
      "-map",
      "0:a:0",
      "-af",
      `loudnorm=${loudnormTarget}:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    options,
  );
  return parseLoudnormJson(stderr);
}

/**
 * Two-pass loudnorm: pass one measures the mix, pass two applies the measured values in linear mode (one
 * static gain, no pumping; loudnorm falls back to its dynamic mode only when that gain would break the
 * true-peak target). Writes a 48 kHz float WAV and returns the pass-one measurement, or null for a silent
 * mix, which is copied through unchanged because silence has no loudness to normalise.
 */
export async function normalizeLoudness(
  input: string,
  output: string,
  options: RunFfmpegOptions,
): Promise<LoudnormAnalysis | null> {
  const out = resolve(output);
  const measured = await measureLoudness(input, options);
  await mkdir(dirname(out), { recursive: true });
  await rm(out, { force: true });
  const silent = !Number.isFinite(measured.integratedLufs);
  const filter = silent
    ? "anull"
    : [
        `loudnorm=${loudnormTarget}`,
        `measured_I=${measured.integratedLufs}`,
        `measured_TP=${measured.truePeakDbtp}`,
        `measured_LRA=${measured.lra}`,
        `measured_thresh=${measured.threshold}`,
        `offset=${measured.targetOffset}`,
        "linear=true",
      ].join(":");
  // loudnorm works at 192 kHz internally; resample back to the mix rate. The explicit format matters on
  // FFmpeg 5.1 (the worker image): when loudnorm falls back to dynamic mode the graph is re-initialised
  // and cannot pick a channel layout on its own.
  const format = `aresample=${MIX_SAMPLE_RATE},aformat=sample_fmts=flt:sample_rates=${MIX_SAMPLE_RATE}:channel_layouts=stereo`;
  await runFfmpeg(
    "loudness normalisation",
    ["-i", resolve(input), "-af", `${filter},${format}`, "-c:a", "pcm_f32le", "-n", out],
    options,
  ).catch(async (err: unknown) => {
    await rm(out, { force: true });
    throw err;
  });
  return silent ? null : measured;
}

/**
 * Audio chain applied while a delivery encodes AAC from the normalised mix (ported from anime-creator
 * `delivery_encodes.tp_safe_af`): an 18 kHz lowpass keeps energy off the encoder cutoff, and a limiter on
 * a 4x-oversampled copy catches inter-sample peaks before the encoder adds its own. Lower bitrates need a
 * lower limit; `gainDb` drives the limiter harder to win back loudness a low limit costs.
 */
export function truePeakSafeFilter(limit: number, gainDb = 0): string {
  const pre = gainDb ? `volume=${gainDb.toFixed(2)}dB,` : "";
  return `${pre}lowpass=f=18000:p=2,aresample=${4 * MIX_SAMPLE_RATE},alimiter=limit=${limit}:attack=1:release=50:level=false:latency=1,aresample=${MIX_SAMPLE_RATE}`;
}

/** One message per broken delivery limit; empty when the measurement may ship. */
export function loudnessProblems(m: LoudnessMeasurement): string[] {
  const issues: string[] = [];
  const { integratedLufs, toleranceLu, truePeakDbtp } = LOUDNESS_TARGET;
  if (!Number.isFinite(m.integratedLufs) || Math.abs(m.integratedLufs - integratedLufs) > toleranceLu)
    issues.push(`loudness ${m.integratedLufs} LUFS, expected ${integratedLufs} +/-${toleranceLu}`);
  if (!(m.truePeakDbtp <= truePeakDbtp)) issues.push(`true peak ${m.truePeakDbtp} dBTP > ${truePeakDbtp}`);
  return issues;
}
