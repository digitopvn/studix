import { type FetchLike, probeSidecarRunners, type SidecarRunnerHealth } from "@studix/agent-runtime";
import type { Logger } from "@studix/shared";
import type { SidecarSettings } from "./sidecar-sandbox-settings.ts";
import type { WorkerSandboxStatus } from "./wiring.ts";

/*
 * Runner readiness of the sidecar sandbox. At startup the worker asks every runner for /v1/info, retrying
 * for a while because Kubernetes may start the sidecars after the worker; it never fails startup, since a
 * task on a down runner fails on its own with an actionable UNAVAILABLE. `/readyz` reports the last result, and
 * "skill runners checked" is logged again whenever a later refresh changes how many runners are ready.
 */

/** About 2 minutes: a new Pod's runner sidecars pull a large image and probe their toolchain before answering. */
const STARTUP_ATTEMPTS = 40;
const STARTUP_INTERVAL_MS = 3_000;
/** `/readyz` refreshes the probe in the background at most this often. */
const REFRESH_INTERVAL_MS = 30_000;

export interface SidecarRunnerMonitor {
  /** Last known readiness; refreshed in the background, so it never waits on a runner. */
  status(): WorkerSandboxStatus;
  /** Resolves once the startup probe finished (all ready, or out of attempts). */
  readonly started: Promise<void>;
  stop(): void;
}

/** The runner errors (addresses, HTTP answers) go to the worker log only; /readyz may be read from outside. */
export function summarizeRunnerHealth(health: readonly SidecarRunnerHealth[]): WorkerSandboxStatus {
  const ready = health.filter((h) => h.ok);
  return {
    backend: "sidecar",
    runners: health.length,
    ready: ready.length,
    versions: [...new Set(ready.map((h) => h.version ?? "unknown"))],
    ...(ready.length === 0
      ? {
          reason:
            "No skill runner is ready; agent tasks with tools fail until one is. The worker log line 'skill runners checked' has the cause.",
        }
      : {}),
  };
}

export function startSidecarRunnerMonitor(
  settings: SidecarSettings,
  logger: Logger,
  options: { fetch?: FetchLike; attempts?: number; intervalMs?: number; refreshMs?: number } = {},
): SidecarRunnerMonitor {
  const probe = () => probeSidecarRunners(settings.runners, options.fetch ? { fetch: options.fetch } : {});
  let last: WorkerSandboxStatus = {
    backend: "sidecar",
    runners: settings.runners.length,
    ready: 0,
    versions: [],
    reason: "The skill runners have not answered yet.",
  };
  let checkedAt = Date.now();
  let reportedReady: number | undefined;

  /** One log line per change in readiness, with the cause of every runner that is down. */
  function report(health: SidecarRunnerHealth[]): void {
    if (last.ready === reportedReady) return;
    reportedReady = last.ready;
    const log = last.ready === 0 ? logger.warn.bind(logger) : logger.info.bind(logger);
    log("skill runners checked", {
      ready: last.ready,
      runners: last.runners,
      versions: last.versions,
      toolchain: health.find((h) => h.ok)?.toolchain ?? {},
      ...(health.some((h) => !h.ok)
        ? { down: health.filter((h) => !h.ok).map((h) => ({ runner: h.runner, error: h.error })) }
        : {}),
    });
  }
  let inFlight = false;
  let stopped = false;

  const started = (async () => {
    const attempts = options.attempts ?? STARTUP_ATTEMPTS;
    for (let i = 1; i <= attempts && !stopped; i++) {
      const health = await probe();
      last = summarizeRunnerHealth(health);
      checkedAt = Date.now();
      const done = health.every((h) => h.ok) || i === attempts;
      if (done) {
        report(health);
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, options.intervalMs ?? STARTUP_INTERVAL_MS).unref?.(),
      );
    }
  })().catch((error: unknown) => logger.warn("skill runner check failed", { error: String(error) }));

  return {
    started,
    stop: () => {
      stopped = true;
    },
    status() {
      if (!inFlight && Date.now() - checkedAt >= (options.refreshMs ?? REFRESH_INTERVAL_MS)) {
        inFlight = true;
        probe()
          .then((health) => {
            last = summarizeRunnerHealth(health);
            if (reportedReady !== undefined) report(health);
          })
          .catch(() => undefined)
          .finally(() => {
            inFlight = false;
            checkedAt = Date.now();
          });
      }
      return last;
    },
  };
}
