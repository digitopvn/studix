import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StudixError } from "@studix/shared";
import type { AspectRatio } from "@studix/video-ir";
import { type GradeLook, gradeFilter } from "./grade.ts";
import {
  LOUDNESS_TARGET,
  type LoudnessMeasurement,
  loudnessProblems,
  measureLoudness,
  truePeakSafeFilter,
} from "./loudness.ts";
import { type RunFfmpegOptions, runFfmpeg } from "./run-process.ts";

/** master: the full render; preview: a light review copy; phone: a 9:16 copy sized for chat and phones. */
export type DeliveryKind = "master" | "preview" | "phone";
export type ExtraDelivery = Exclude<DeliveryKind, "master">;

export interface FinishInput {
  /** Captured H.264 picture; its own audio, if any, is ignored. */
  video: string;
  /** Loudness-normalised mix (WAV); omitted for a render without sound. */
  audio?: string;
  outDir: string;
  /** File-name stem; deliveries are `<name>.mp4`, `<name>.preview.mp4` and `<name>.phone.mp4`. */
  name: string;
  durationMs: number;
  /** IR aspect ratio: the phone copy exists only for 9:16. */
  aspectRatio: AspectRatio;
  /** Master CRF when the picture is re-encoded for a grade. */
  crf: number;
  /** Optional colour look; without it the captured picture is stream-copied. */
  grade?: GradeLook;
  extras: readonly ExtraDelivery[];
}

export interface FinishedFile {
  kind: DeliveryKind;
  filePath: string;
  /** Measured on the delivered file; absent for a render without sound. */
  loudness?: LoudnessMeasurement;
}

/** Limiter ceilings per AAC rate (anime-creator measurements): 128k glitched over 0.75, so phone uses 0.6. */
const MASTER_AUDIO = { kbps: 192, limit: 0.8 } as const;
const PHONE_AUDIO = { kbps: 128, limit: 0.6 } as const;
/** Chat apps refuse files over 30 MiB; the phone copy is two-pass sized under this. */
const PHONE_TARGET_MIB = 28;
const PHONE_MAX_VIDEO_KBPS = 6000;
const PHONE_WIDTH = 720;
const PREVIEW_LONG_EDGE = 640;
/** Corrective passes may raise the limiter drive this many times, by at most this much in total. */
const MAX_GAIN_PASSES = 3;
const MAX_GAIN_CORRECTION_DB = 9;

const SILENT_SOURCE = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"];
const MP4_TAIL = ["-movflags", "+faststart", "-n"];

/** Video bitrate (kbit/s) that lands a two-pass encode under `targetMib` with container overhead. */
export function phoneVideoKbps(durationMs: number, audioKbps: number, targetMib = PHONE_TARGET_MIB): number {
  const totalKbit = (targetMib * 1024 * 1024 * 8 * 0.97) / 1000;
  const kbps = Math.floor(totalKbit / Math.max(durationMs / 1000, 0.1) - audioKbps);
  return Math.min(PHONE_MAX_VIDEO_KBPS, Math.max(150, kbps));
}

/** Audio arguments for input 1: the mix through the true-peak-safe chain, or silence. */
function audioArgs(input: FinishInput, audio: { kbps: number; limit: number }, gainDb: number): string[] {
  if (!input.audio) return ["-c:a", "aac", "-b:a", "128k", "-shortest"];
  return ["-af", truePeakSafeFilter(audio.limit, gainDb), "-c:a", "aac", "-b:a", `${audio.kbps}k`];
}

function audioInput(input: FinishInput): string[] {
  return input.audio ? ["-i", resolve(input.audio)] : SILENT_SOURCE;
}

async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

/**
 * Encodes one delivery and measures it. When the file is too quiet (the limiter cost level on peaky
 * material), the audio is encoded again with the missing gain driven into the limiter, a few times at
 * most; a delivery that still misses the target fails, so a file outside -14 LUFS +/-1 / -1.5 dBTP is
 * never returned.
 */
async function encodeMeasured(
  kind: DeliveryKind,
  input: FinishInput,
  out: string,
  encode: (gainDb: number) => Promise<void>,
  options: RunFfmpegOptions,
): Promise<FinishedFile> {
  await removeQuietly(out);
  await encode(0);
  if (!input.audio) return { kind, filePath: out };
  let measured = await measureLoudness(out, options);
  let gainDb = 0;
  for (let pass = 0; pass < MAX_GAIN_PASSES && loudnessProblems(measured).length > 0; pass++) {
    const next = Math.min(
      MAX_GAIN_CORRECTION_DB,
      gainDb + LOUDNESS_TARGET.integratedLufs - measured.integratedLufs,
    );
    if (!Number.isFinite(next) || next <= gainDb) break;
    gainDb = next;
    await removeQuietly(out);
    await encode(gainDb);
    measured = await measureLoudness(out, options);
  }
  const loudness = { integratedLufs: measured.integratedLufs, truePeakDbtp: measured.truePeakDbtp };
  const problems = loudnessProblems(loudness);
  if (problems.length > 0) {
    throw new StudixError("INTERNAL", `${kind} delivery misses the loudness target: ${problems.join("; ")}`, {
      details: { kind, loudness },
      retryable: false,
    });
  }
  return { kind, filePath: out, loudness };
}

async function encodeMaster(input: FinishInput, options: RunFfmpegOptions): Promise<FinishedFile> {
  const out = resolve(input.outDir, `${input.name}.mp4`);
  const video = input.grade
    ? ["-vf", gradeFilter(input.grade), "-c:v", "libx264", "-preset", "medium", "-crf", String(input.crf)]
    : ["-c:v", "copy"];
  return encodeMeasured(
    "master",
    input,
    out,
    (gainDb) =>
      runFfmpeg(
        "master mux",
        [
          "-i",
          resolve(input.video),
          ...audioInput(input),
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          ...video,
          ...audioArgs(input, MASTER_AUDIO, gainDb),
          ...MP4_TAIL,
          out,
        ],
        options,
      ).then(() => undefined),
    options,
  );
}

/** Smaller picture, the master's measured audio stream copied (a re-encode would move the true peak). */
async function encodePreview(
  input: FinishInput,
  master: string,
  options: RunFfmpegOptions,
): Promise<FinishedFile> {
  const out = resolve(input.outDir, `${input.name}.preview.mp4`);
  const e = PREVIEW_LONG_EDGE;
  const scale = `scale='if(gte(iw,ih),min(${e},iw),-2)':'if(gte(iw,ih),-2,min(${e},ih))':flags=lanczos`;
  return encodeMeasured(
    "preview",
    input,
    out,
    () =>
      runFfmpeg(
        "preview encode",
        [
          "-i",
          master,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0",
          "-vf",
          scale,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "30",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "copy",
          ...MP4_TAIL,
          out,
        ],
        options,
      ).then(() => undefined),
    options,
  );
}

/** Two-pass, sized under the chat upload limit, audio encoded once from the mix at the phone ceiling. */
async function encodePhone(
  input: FinishInput,
  master: string,
  options: RunFfmpegOptions,
): Promise<FinishedFile> {
  const out = resolve(input.outDir, `${input.name}.phone.mp4`);
  const passLog = join(resolve(input.outDir), `${input.name}.phone-2pass`);
  const video = [
    "-vf",
    `scale='min(${PHONE_WIDTH},iw)':-2:flags=lanczos`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    `${phoneVideoKbps(input.durationMs, PHONE_AUDIO.kbps)}k`,
    "-passlogfile",
    passLog,
  ];
  try {
    // Pass one writes to the null muxer: a NUL/os.devnull output path breaks on Windows.
    await runFfmpeg(
      "phone pass 1",
      ["-i", master, "-map", "0:v:0", ...video, "-pass", "1", "-an", "-f", "null", "-"],
      options,
    );
    return await encodeMeasured(
      "phone",
      input,
      out,
      (gainDb) =>
        runFfmpeg(
          "phone pass 2",
          [
            "-i",
            master,
            ...audioInput(input),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            ...video,
            "-pass",
            "2",
            ...audioArgs(input, PHONE_AUDIO, gainDb),
            ...MP4_TAIL,
            out,
          ],
          options,
        ).then(() => undefined),
      options,
    );
  } finally {
    const stem = `${input.name}.phone-2pass`;
    const files = await readdir(resolve(input.outDir)).catch(() => [] as string[]);
    await Promise.all(
      files.filter((f) => f.startsWith(stem)).map((f) => removeQuietly(join(input.outDir, f))),
    );
  }
}

/**
 * FFmpeg finish: muxes the captured picture with the normalised mix into the master (optionally graded),
 * then derives the requested extra deliveries from it. Every file with sound is measured. FFmpeg always
 * runs with an argv array, never a shell string, and never overwrites silently (`-n` after an explicit
 * delete of this render's own outputs). On failure every delivery written so far is removed.
 */
export async function finishDeliveries(
  input: FinishInput,
  options: RunFfmpegOptions,
): Promise<FinishedFile[]> {
  const done: FinishedFile[] = [];
  try {
    const master = await encodeMaster(input, options);
    done.push(master);
    if (input.extras.includes("preview")) done.push(await encodePreview(input, master.filePath, options));
    if (input.extras.includes("phone") && input.aspectRatio === "9:16")
      done.push(await encodePhone(input, master.filePath, options));
    return done;
  } catch (err) {
    await Promise.all(
      [
        resolve(input.outDir, `${input.name}.mp4`),
        resolve(input.outDir, `${input.name}.preview.mp4`),
        resolve(input.outDir, `${input.name}.phone.mp4`),
      ].map(removeQuietly),
    );
    throw err;
  }
}
