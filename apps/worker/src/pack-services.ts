import { join } from "node:path";
import { createLiveCredentialEnv, createSecretBox, parseSecretKey } from "@studix/auth";
import { createRepositories } from "@studix/database";
import { createMultixProviderFromConfig, MULTIX_VENDOR_KEYS } from "@studix/providers";
import {
  assertSpeechProbeReady,
  createHardQaGate,
  createSpeechProbe,
  qaToolchainStatus,
  resolveQaToolchain,
} from "@studix/qa";
import { StudixError, toStudixError } from "@studix/shared";
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
export async function loadPackServices(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
): Promise<Pick<WorkerPorts, "media" | "qa" | "speech">> {
  const { config } = settings;
  // Vendor keys the operator saved in the dashboard (sealed rows) over the process environment. They are
  // reloaded on a timer, so a rotation reaches new jobs without a redeploy; a running job keeps its env.
  const credentialEnv = createLiveCredentialEnv({
    credentials: createRepositories(runtime.db).platformCredentials,
    secrets: config.STUDIX_SECRETS_KEY
      ? createSecretBox(
          parseSecretKey(config.STUDIX_SECRETS_KEY),
          config.STUDIX_SECRETS_KEYS_PREVIOUS.map(parseSecretKey),
        )
      : undefined,
    base: runtime.env,
    names: Object.values(MULTIX_VENDOR_KEYS),
    logger: runtime.logger,
  });
  await credentialEnv.refresh().catch(() => undefined);
  const stopCredentialRefresh = credentialEnv.start();
  runtime.signal.addEventListener("abort", stopCredentialRefresh, { once: true });
  const media = createMultixProviderFromConfig(config, { env: credentialEnv.env });
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
  const sandboxRoot = join(settings.workDir, "qa");
  const speech = config.STUDIX_SPEECH_GATE
    ? createSpeechProbe({
        run: {
          toolchain,
          timeoutMs: SPEECH_TOOL_TIMEOUT_MS,
          sandboxRoot,
          ffmpegPath: config.FFMPEG_PATH,
          ffprobePath: config.FFPROBE_PATH,
        },
      })
    : undefined;
  if (speech) {
    // Every sound effect is paid for before it is measured, so a probe that cannot run must stop the worker now.
    try {
      await assertSpeechProbeReady(speech, sandboxRoot, runtime.signal);
    } catch (err) {
      const cause = toStudixError(err);
      // Only a missing tool means "wrong image"; a timeout or out-of-memory needs a different fix.
      throw new StudixError(
        cause.code,
        `STUDIX_SPEECH_GATE is on but the speech-activity tool cannot run: ${cause.message}`,
        {
          retryable: false,
          cause: err,
          details: { probeCode: cause.code },
          suggestedAction:
            cause.code === "UNAVAILABLE"
              ? "Run the worker on the QA image built with STUDIX_QA_EXTRAS=speech, or unset STUDIX_SPEECH_GATE."
              : "Check the speech image (memory limit, ffmpeg, timeout) with `speech-activity` on a short clip, or unset STUDIX_SPEECH_GATE.",
        },
      );
    }
  }
  return {
    media,
    ...(speech ? { speech } : {}),
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
