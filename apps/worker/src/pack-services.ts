import { join } from "node:path";
import {
  createPlatformCredentialService,
  createSecretBox,
  type PlatformCredentialService,
  parseSecretKey,
} from "@studix/auth";
import { createRepositories } from "@studix/database";
import { createMultixProviderFromConfig, MULTIX_VENDOR_KEYS, MULTIX_VENDORS } from "@studix/providers";
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
import { providerConnections } from "./worker-ports.ts";
import type { WorkerPortsRuntime } from "./worker-process.ts";
import type { WorkerSettings } from "./worker-settings.ts";

/** Longest a single QA tool may measure one render. */
const QA_TOOL_TIMEOUT_MS = 120_000;
/** Longest the speech check may take on one sound effect (a few seconds of audio plus loading the model). */
const SPEECH_TOOL_TIMEOUT_MS = 60_000;

/** The dashboard-managed vendor keys, or undefined without STUDIX_SECRETS_KEY (nothing can be stored then). */
function platformCredentials(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
): PlatformCredentialService | undefined {
  const { config } = settings;
  const repos = createRepositories(runtime.db);
  if (!config.STUDIX_SECRETS_KEY) {
    // The app may hold keys an operator set in the dashboard; without the master key this worker cannot open them.
    void repos.platformCredentials.list().then(
      (rows) => {
        if (rows.length > 0) {
          runtime.logger.warn(
            "dashboard-stored media keys exist but STUDIX_SECRETS_KEY is not set on the worker; they are ignored here",
            { count: rows.length },
          );
        }
      },
      () => {},
    );
    return undefined;
  }
  return createPlatformCredentialService({
    credentials: repos.platformCredentials,
    audit: repos.audit,
    secrets: createSecretBox(
      parseSecretKey(config.STUDIX_SECRETS_KEY),
      config.STUDIX_SECRETS_KEYS_PREVIOUS.map(parseSecretKey),
    ),
    allowedNames: MULTIX_VENDORS.map((vendor) => MULTIX_VENDOR_KEYS[vendor]),
    env: runtime.env,
    logger: runtime.logger,
  });
}

/**
 * The media provider and QA gate pack stages run with. Multix stays disabled (every paid stage fails
 * UNAVAILABLE) until MULTIX_BIN is set; a missing QA toolchain is logged at startup and fails the QA stage
 * rather than letting an unmeasured render ship.
 */
export async function loadPackServices(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
): Promise<Pick<WorkerPorts, "media" | "qa" | "speech" | "mediaStatus">> {
  const { config } = settings;
  const credentials = platformCredentials(settings, runtime);
  const workspaceKeys = providerConnections(settings, runtime);
  const media = createMultixProviderFromConfig(config, {
    env: runtime.env,
    // Vendor keys an operator set in the dashboard apply to the next Multix call, with no restart.
    ...(credentials ? { credentials: () => credentials.loadValues() } : {}),
    // A workspace's own vendor keys (BYOK) win for that workspace's media calls only.
    ...(workspaceKeys ? { workspaceCredentials: (ctx) => workspaceKeys.resolveMediaKeys(ctx) } : {}),
  });
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
    mediaStatus: async () => {
      const diagnosis = await media.diagnose();
      return {
        executable: config.MULTIX_BIN ? "configured" : "missing",
        state: diagnosis.state,
        ...(diagnosis.state === "ready" || !diagnosis.code ? {} : { code: diagnosis.code }),
        secretsKey: Boolean(config.STUDIX_SECRETS_KEY),
        vendors: { ...diagnosis.vendors },
      };
    },
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
