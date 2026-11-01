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
