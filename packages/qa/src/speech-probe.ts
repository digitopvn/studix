import type { SpeechProbe } from "@studix/workflow";
import { QA_TOOLS, type QaRunOptions, runQaTool } from "./qa-tools.ts";

/** Run options of the speech tool; the media grant is set by the probe itself. */
export type SpeechProbeOptions = Omit<QaRunOptions, "media" | "outputDir" | "signal">;

/**
 * The speech port backed by the `speech` QA tool (Silero VAD). A tool failure, including UNAVAILABLE on an image
 * without the `vad` extra, rejects: a sound that was not measured is never reported as clean.
 */
export function createSpeechProbe(options: SpeechProbeOptions): SpeechProbe {
  return {
    async measure(filePath, signal) {
      const { result } = await runQaTool(
        QA_TOOLS.speech,
        { media: "media" },
        { ...options, media: { media: filePath }, signal },
      );
      return { speechMs: result.speechMs, durationMs: result.durationMs };
    },
  };
}
