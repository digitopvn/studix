import { join } from "node:path";
import { createMultixProviderFromConfig } from "@studix/providers";
import { createHardQaGate, createSpeechProbe, qaToolchainStatus, resolveQaToolchain } from "@studix/qa";
import { knowledgeCatalog } from "@studix/skills";
import type { WorkerPorts } from "./wiring.ts";
import type { WorkerPortsRuntime } from "./worker-process.ts";
import type { WorkerSettings } from "./worker-settings.ts";

/** Longest a single QA tool may measure one render. */
const QA_TOOL_TIMEOUT_MS = 120_000;
/** Longest the speech check may take on one sound effect (a few seconds of audio plus loading the model). */
const SPEECH_TOOL_TIMEOUT_MS = 60_000;

/**
 * The media provider and QA gate pack stages run with. Multix stays disabled (every paid stage fails
 * UNAVAILABLE) until MULTIX_BIN is set; a missing QA toolchain is logged at startup and fails the QA stage
 * rather than letting an unmeasured render ship.
 */
export function loadPackServices(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
): Pick<WorkerPorts, "media" | "qa" | "speech"> {
  const { config } = settings;
  const media = createMultixProviderFromConfig(config, { env: runtime.env });
  const toolchain = resolveQaToolchain(runtime.env);
  const qaStatus = qaToolchainStatus(toolchain, runtime.env);
  if (!qaStatus.ok) {
    runtime.logger.warn("QA toolchain incomplete; pack QA stages will fail until it is installed", {
      reason: qaStatus.reason,
    });
  }
  const status = media.status();
  runtime.logger.info("pack services ready", {
    media: status.enabled ? media.id : `off (${status.reason})`,
    qa: qaStatus.ok ? "ready" : "toolchain missing",
    speechGate: config.STUDIX_SPEECH_GATE ? "on" : "off",
  });
  return {
    media,
    ...(config.STUDIX_SPEECH_GATE
      ? {
          speech: createSpeechProbe({
            run: {
              toolchain,
              timeoutMs: SPEECH_TOOL_TIMEOUT_MS,
              sandboxRoot: join(settings.workDir, "qa"),
              ffmpegPath: config.FFMPEG_PATH,
              ffprobePath: config.FFPROBE_PATH,
            },
          }),
        }
      : {}),
    qa: createHardQaGate({
      run: {
        toolchain,
        timeoutMs: QA_TOOL_TIMEOUT_MS,
        sandboxRoot: join(settings.workDir, "qa"),
        ffmpegPath: config.FFMPEG_PATH,
        ffprobePath: config.FFPROBE_PATH,
      },
      hardChecks: () => knowledgeCatalog.hardChecks(),
    }),
  };
}
