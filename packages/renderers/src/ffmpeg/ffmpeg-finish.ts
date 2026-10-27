import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StudixError } from "@studix/shared";
import { runProcess } from "./run-process.ts";

export interface FinishMp4Options {
  /** ffmpeg binary; pass config.FFMPEG_PATH. */
  ffmpegPath?: string;
  /** Silent stereo AAC track for inputs without audio, so every delivery has the RenderSpec audio codec. */
  addSilentAudio: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Final packaging of a rendered H.264 stream: the video is stream-copied (no second lossy encode), an AAC
 * track is added, and `+faststart` moves the moov atom up front so players start before the download ends.
 * A failed or cancelled run removes the partial output so callers never upload a truncated file.
 */
export async function finishMp4(input: string, output: string, options: FinishMp4Options): Promise<void> {
  const out = resolve(output);
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", resolve(input)];
  if (options.addSilentAudio) {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    args.push("-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest");
  } else {
    args.push("-map", "0:v:0", "-map", "0:a?", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k");
  }
  args.push("-movflags", "+faststart", out);
  await mkdir(dirname(out), { recursive: true });
  const result = await runProcess(options.ffmpegPath ?? "ffmpeg", args, {
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    signal: options.signal,
  }).catch(async (err: unknown) => {
    await rm(out, { force: true });
    throw err;
  });
  if (result.exitCode !== 0) {
    await rm(out, { force: true });
    throw new StudixError("INTERNAL", `ffmpeg finishing failed (exit ${result.exitCode})`, {
      details: { stderr: result.stderr.slice(-2000) },
    });
  }
}
