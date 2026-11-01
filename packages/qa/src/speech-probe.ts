import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StudixError } from "@studix/shared";
import type { SpeechMeasurement, SpeechProbe } from "@studix/workflow";
import { QA_TOOLS, type QaRunOptions, runQaTool } from "./qa-tools.ts";

/** Voiced time at which a file counts as containing speech; a click or a breath of pitch stays below it. */
export const SPEECH_MIN_MS = 300;

export interface SpeechProbeOptions {
  /** Toolchain and sandbox of the Python run (the same as the QA gate's). */
  run: Omit<QaRunOptions, "media" | "signal">;
  /** Voiced milliseconds from which a file counts as speech; defaults to `SPEECH_MIN_MS`. */
  minSpeechMs?: number;
}

/**
 * The worker's speech probe: the `speech-activity` QA tool (Silero VAD) on one generated file. On the default
 * image the tool answers UNAVAILABLE, and so does the probe: a file that could not be measured is never clean.
 */
export function createSpeechProbe(options: SpeechProbeOptions): SpeechProbe {
  const minSpeechMs = options.minSpeechMs ?? SPEECH_MIN_MS;
  return {
    async measure(filePath, signal): Promise<SpeechMeasurement> {
      const { result } = await runQaTool(
        QA_TOOLS.speechActivity,
        { media: "clip" },
        { ...options.run, media: { clip: filePath }, signal },
      );
      return {
        speechMs: result.speechMs,
        durationMs: result.durationMs,
        speech: result.speechMs >= minSpeechMs,
      };
    },
  };
}

/** One second of 16 kHz mono silence as a PCM WAV: the smallest real audio file the detector can decode. */
function silentWav(seconds = 1, sampleRate = 16_000): Buffer {
  const data = Buffer.alloc(seconds * sampleRate * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Runs the speech probe once on a silent clip, through the same sandbox, memory limit and image a real check
 * uses. Call it at worker start when the speech gate is on: a missing `speech` image (UNAVAILABLE), a torch
 * import that does not fit the sandbox, or a broken toolchain then stops the worker before any paid sound
 * effect is generated, instead of failing each one after it was billed. Throws the probe's own error.
 */
export async function assertSpeechProbeReady(
  probe: SpeechProbe,
  sandboxRoot: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  await mkdir(sandboxRoot, { recursive: true });
  const dir = await mkdtemp(join(sandboxRoot, "speech-ready-"));
  try {
    const clip = join(dir, "silence.wav");
    await writeFile(clip, silentWav());
    const heard = await probe.measure(clip, signal);
    // A detector that hears speech in silence would make every effect fail after it was paid for.
    if (heard.speech)
      throw new StudixError("INTERNAL", "speech probe heard speech in a silent clip", {
        retryable: false,
        details: { speechMs: heard.speechMs },
      });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
