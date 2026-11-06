import type { StorageAdapter } from "@studix/core";
import type { Logger } from "@studix/shared";
import { probeStorageWriteAccess, type StorageProbeResult } from "@studix/storage";

export interface StorageReadiness {
  /** Latest probe result; re-probes at most once per `ttlMs` so frequent kubelet probes stay cheap. */
  check(): Promise<StorageProbeResult>;
}

/** Cached write/read/delete probe against object storage, logging transitions (never secrets). */
export function createStorageReadiness(
  storage: StorageAdapter,
  logger: Logger,
  options: { ttlMs?: number; now?: () => number } = {},
): StorageReadiness {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  let last: { at: number; result: StorageProbeResult } | undefined;
  let inflight: Promise<StorageProbeResult> | undefined;
  return {
    check() {
      if (last && now() - last.at < ttlMs) return Promise.resolve(last.result);
      inflight ??= probeStorageWriteAccess(storage)
        .then((result) => {
          const wasOk = last?.result.ok;
          last = { at: now(), result };
          if (!result.ok) {
            logger.error("object storage write probe failed; render uploads will fail until fixed", {
              step: result.step,
              status: result.status,
              message: result.message,
              hint: result.hint,
            });
          } else if (wasOk === false) {
            logger.info("object storage write probe recovered", { durationMs: result.durationMs });
          } else if (wasOk === undefined) {
            logger.info("object storage write probe ok", { durationMs: result.durationMs });
          }
          return result;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}
