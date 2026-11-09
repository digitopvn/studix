import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StudixError } from "@studix/shared";
import { runFfmpeg } from "./run-process.ts";

/*
 * Frame-level checks of a rendered video: a few frames are decoded at evenly spaced timestamps, analysed as
 * small grayscale thumbnails, and tiled into a contact sheet. Duration, fps and codec checks cannot see a
 * black render, text clipped by the frame edge or a scene that never moves; these can.
 */

const W = 160;
const H = 90;
/** A pixel counts as content when its luma differs this much from the frame's edge background. */
const CONTRAST = 40;
/** Mean luma under this (0-255) with almost no spread is a black frame. */
const BLACK_MEAN = 12;
/** A pixel counts as drawn when it differs this much from the frame's median luma (a small caption is faint). */
const DRAWN_DELTA = 4;
/** Fewer drawn pixels than this share of the thumbnail is a blank frame, whatever its colour. */
const BLANK_SHARE = 0.001;
/** Mean absolute luma change between two samples under this is "did not change". */
const STATIC_DIFF = 0.5;
/** Share of margin pixels that may differ from the background before content counts as inside the margin. */
const MARGIN_TOLERANCE = 0.002;

export interface FrameQaOptions {
  /** Frames to sample, evenly spaced and never on the very first or last frame. */
  samples: number;
  /** Report content that reaches into this outer band of the frame, as a percentage of each side. */
  safeMarginPct?: number;
  /** Report consecutive samples that look identical. */
  motion?: boolean;
  /** Scratch folder for the decoded frame. */
  workDir: string;
  ffmpegPath?: string;
  signal?: AbortSignal;
}

export interface FrameSample {
  index: number;
  timeMs: number;
  meanLuma: number;
  spread: number;
}

export interface FrameQaResult {
  samples: FrameSample[];
  problems: string[];
}

/** Evenly spaced sample times inside (0, duration), as in 1/(n+1) ... n/(n+1) of the video. */
export function sampleTimesMs(durationMs: number, samples: number): number[] {
  return Array.from({ length: samples }, (_, i) => Math.round((durationMs * (i + 1)) / (samples + 1)));
}

const clock = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Analyse one grayscale thumbnail (W x H bytes). */
export function analyseGrayFrame(
  gray: Uint8Array,
  safeMarginPct?: number,
): { meanLuma: number; spread: number; drawn: number; edgeContent: number; marginContent: number } {
  const n = gray.length;
  let sum = 0;
  for (const v of gray) sum += v;
  const mean = sum / n;
  let variance = 0;
  for (const v of gray) variance += (v - mean) ** 2;
  const spread = Math.sqrt(variance / n);
  const sorted = Uint8Array.from(gray).sort();
  const median = sorted[Math.floor(n / 2)] as number;
  let drawnPixels = 0;
  for (const v of gray) if (Math.abs(v - median) > DRAWN_DELTA) drawnPixels++;
  const drawn = drawnPixels / n;

  // Background = the median of the outermost ring: text and graphics rarely start at the very edge.
  const ring: number[] = [];
  for (let x = 0; x < W; x++) ring.push(gray[x] as number, gray[(H - 1) * W + x] as number);
  for (let y = 1; y < H - 1; y++) ring.push(gray[y * W] as number, gray[y * W + W - 1] as number);
  ring.sort((a, b) => a - b);
  const background = ring[Math.floor(ring.length / 2)] as number;

  const differs = (x: number, y: number) =>
    Math.abs((gray[y * W + x] as number) - background) > CONTRAST ? 1 : 0;

  let edge = 0;
  for (let x = 0; x < W; x++) edge += differs(x, 0) + differs(x, H - 1);
  for (let y = 1; y < H - 1; y++) edge += differs(0, y) + differs(W - 1, y);
  const edgeContent = edge / ring.length;

  let marginContent = 0;
  if (safeMarginPct) {
    const mx = Math.max(1, Math.round((W * safeMarginPct) / 100));
    const my = Math.max(1, Math.round((H * safeMarginPct) / 100));
    let inBand = 0;
    let total = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (x >= mx && x < W - mx && y >= my && y < H - my) continue;
        total++;
        inBand += differs(x, y);
      }
    }
    marginContent = inBand / total;
  }
  return { meanLuma: mean, spread, drawn, edgeContent, marginContent };
}

/** Mean absolute luma difference between two thumbnails. */
export function frameDifference(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] as number) - (b[i] as number));
  return sum / a.length;
}

/** Problems found in analysed frames; the pure part of {@link checkFrames}. */
export function frameProblems(
  times: number[],
  frames: Uint8Array[],
  options: Pick<FrameQaOptions, "safeMarginPct" | "motion">,
): { samples: FrameSample[]; problems: string[] } {
  const problems: string[] = [];
  const samples: FrameSample[] = [];
  frames.forEach((gray, i) => {
    const at = clock(times[i] as number);
    const a = analyseGrayFrame(gray, options.safeMarginPct);
    samples.push({
      index: i + 1,
      timeMs: times[i] as number,
      meanLuma: Math.round(a.meanLuma * 10) / 10,
      spread: Math.round(a.spread * 10) / 10,
    });
    if (a.drawn < BLANK_SHARE) {
      problems.push(
        a.meanLuma < BLACK_MEAN
          ? `black frame at ${at}`
          : `blank frame at ${at} (one flat colour, nothing drawn)`,
      );
      return;
    }
    if (options.safeMarginPct && a.marginContent > MARGIN_TOLERANCE) {
      problems.push(
        `content inside the ${options.safeMarginPct}% safe margin at ${at}` +
          (a.edgeContent > MARGIN_TOLERANCE ? " and touching the frame edge (clipped?)" : ""),
      );
    }
  });
  if (options.motion) {
    for (let i = 1; i < frames.length; i++) {
      if (frameDifference(frames[i - 1] as Uint8Array, frames[i] as Uint8Array) < STATIC_DIFF) {
        problems.push(
          `no visible change between ${clock(times[i - 1] as number)} and ${clock(times[i] as number)}`,
        );
      }
    }
  }
  return { samples, problems };
}

async function grayFrame(file: string, timeMs: number, out: string, o: FrameQaOptions): Promise<Uint8Array> {
  await runFfmpeg(
    "frame decode",
    [
      "-loglevel",
      "error",
      "-ss",
      (timeMs / 1000).toFixed(3),
      "-i",
      resolve(file),
      "-frames:v",
      "1",
      "-vf",
      `scale=${W}:${H}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-y",
      out,
    ],
    { ffmpegPath: o.ffmpegPath, signal: o.signal, timeoutMs: 60_000 },
  );
  const bytes = await readFile(out);
  if (bytes.length !== W * H) throw new Error(`could not decode a frame at ${clock(timeMs)}`);
  return new Uint8Array(bytes);
}

/** Decode the sample frames and report blank, black, margin and motion problems. */
export async function checkFrames(
  file: string,
  durationMs: number,
  options: FrameQaOptions,
): Promise<FrameQaResult> {
  const times = sampleTimesMs(durationMs, options.samples);
  await mkdir(options.workDir, { recursive: true });
  const out = join(options.workDir, "frame.gray");
  const frames: Uint8Array[] = [];
  const keptTimes: number[] = [];
  const missing: string[] = [];
  try {
    for (const t of times) {
      try {
        frames.push(await grayFrame(file, t, out, options));
        keptTimes.push(t);
      } catch (err) {
        // A cancel or a timeout is not a verdict on the file.
        if (err instanceof StudixError && (err.code === "CANCELLED" || err.code === "TIMEOUT")) throw err;
        missing.push(
          `no video frame at ${clock(t)} (audio-only file, or the video is shorter than the file?)`,
        );
      }
    }
  } finally {
    await rm(out, { force: true }).catch(() => undefined);
  }
  const seen = frameProblems(keptTimes, frames, options);
  return { samples: seen.samples, problems: [...missing, ...seen.problems] };
}

/** Tile the sample frames (about 320 px wide each, three per row) into one JPEG. Returns its byte size. */
export async function writeContactSheet(
  file: string,
  durationMs: number,
  samples: number,
  out: string,
  options: { ffmpegPath?: string; signal?: AbortSignal; workDir: string },
): Promise<number> {
  const times = sampleTimesMs(durationMs, samples);
  const dir = join(options.workDir, "contact");
  await mkdir(dir, { recursive: true });
  await mkdir(dirname(out), { recursive: true });
  try {
    for (const [i, t] of times.entries()) {
      await runFfmpeg(
        "contact sheet frame",
        [
          "-ss",
          (t / 1000).toFixed(3),
          "-i",
          resolve(file),
          "-frames:v",
          "1",
          "-vf",
          "scale=320:-2",
          "-y",
          join(dir, `f${i + 1}.png`),
        ],
        { ...options, timeoutMs: 60_000 },
      );
    }
    const cols = Math.min(3, samples);
    await runFfmpeg(
      "contact sheet tile",
      [
        "-framerate",
        "1",
        "-i",
        join(dir, "f%d.png"),
        "-vf",
        `tile=${cols}x${Math.ceil(samples / cols)}:padding=4:color=0x202020`,
        "-frames:v",
        "1",
        "-q:v",
        "5",
        "-y",
        out,
      ],
      { ...options, timeoutMs: 60_000 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return (await readFile(out)).length;
}
