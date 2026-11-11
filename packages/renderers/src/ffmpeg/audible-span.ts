import { resolve } from "node:path";
import { type RunFfmpegOptions, runFfmpeg } from "./run-process.ts";

/** Where the sound of an audio file starts and ends, in milliseconds from the start of the file. */
export interface AudibleSpan {
  /** Length of the decoded file. */
  durationMs: number;
  /** End of the leading silence; 0 when the file opens on sound. */
  startMs: number;
  /** Start of the trailing silence; `durationMs` when the file ends on sound. */
  endMs: number;
}

/**
 * Quieter than this is silence. Speech models pad a take with digital (or near-digital) silence, far under
 * the softest syllable onset, so a low threshold trims only the padding.
 */
const SILENCE_DB = -50;
/** A shorter quiet stretch is a pause inside the sound, not padding. */
const MIN_SILENCE_S = 0.05;
/** Timestamps within this of the file's start or end count as at it (silencedetect rounds to samples). */
const EDGE_S = 0.01;

const seconds = (value: string): number => {
  const [h, m, s] = value.split(":").map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
};

/** Decoded length from ffmpeg's log: the final progress `time=`, else the input's `Duration:`. */
function totalSeconds(stderr: string): number | undefined {
  const times = [...stderr.matchAll(/time=(\d+:\d{2}:\d{2}(?:\.\d+)?)/g)];
  const last = times.at(-1)?.[1];
  const duration = last ?? stderr.match(/Duration: (\d+:\d{2}:\d{2}(?:\.\d+)?)/)?.[1];
  if (duration === undefined) return undefined;
  const total = seconds(duration);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/**
 * The audible span from the log of an ffmpeg `silencedetect` pass. Undefined when the log names no length
 * or the file is silent throughout: there is no span to trust. Older FFmpeg prints no `silence_end` for
 * silence that runs to the end of the file, newer prints one at the end; both mean trailing silence.
 */
export function parseAudibleSpan(stderr: string): AudibleSpan | undefined {
  const logged = totalSeconds(stderr);
  if (logged === undefined) return undefined;
  const events = [...stderr.matchAll(/silence_(start|end): (-?[\d.]+)/g)].map((m) => ({
    kind: m[1] as "start" | "end",
    at: Number(m[2]),
  }));
  // The log's length is in centiseconds; a silence that ends at the end of the file says it to the sample.
  const total = Math.max(logged, ...events.map((e) => e.at));
  let start = 0;
  let end = total;
  const first = events[0];
  if (first?.kind === "start" && first.at <= EDGE_S) {
    const lead = events[1];
    if (lead?.kind !== "end" || lead.at >= total - EDGE_S) return undefined;
    start = lead.at;
  }
  const lastStart = events.findLastIndex((e) => e.kind === "start");
  const tail = events[lastStart];
  if (tail && tail.at > start) {
    const after = events[lastStart + 1];
    if (after === undefined || after.at >= total - EDGE_S) end = tail.at;
  }
  if (end <= start) return undefined;
  return {
    durationMs: Math.round(total * 1000),
    startMs: Math.round(start * 1000),
    endMs: Math.round(end * 1000),
  };
}

/**
 * Measure where the sound of `file`'s first audio stream starts and ends (ffmpeg `silencedetect`). Throws
 * when ffmpeg cannot read the file; resolves undefined when it has no sound to measure.
 */
export async function measureAudibleSpan(
  file: string,
  options: RunFfmpegOptions,
): Promise<AudibleSpan | undefined> {
  const stderr = await runFfmpeg(
    "silence measurement",
    [
      "-i",
      resolve(file),
      "-map",
      "0:a:0",
      "-af",
      `silencedetect=noise=${SILENCE_DB}dB:d=${MIN_SILENCE_S}`,
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 60_000, ...options },
  );
  return parseAudibleSpan(stderr);
}
