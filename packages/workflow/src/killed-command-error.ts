import { StudixError } from "@studix/shared";

export interface KilledCommandInput {
  /** What was killed, e.g. "The command" or "ffmpeg". */
  subject: string;
  timeoutSeconds: number;
  maxTimeoutSeconds: number;
  durationMs: number;
  details: Record<string, unknown>;
}

/** True when a killed sandbox command ran for its whole `timeoutSeconds`, so the timeout is what stopped it. */
export function reachedTimeout(durationMs: number, timeoutSeconds: number): boolean {
  return durationMs >= timeoutSeconds * 1000;
}

/**
 * The error for a sandbox command that never exited on its own (no exit code). Cancel and job deadline are
 * reported by the executor from the stage signal, so this only sees the two remaining causes:
 * - the run hit its own `timeoutSeconds`: TIMEOUT, not retryable, because the same command with the same
 *   timeout is killed again; the caller has to change the request first;
 * - it was killed earlier (the sandbox runner stopped or lost the session): UNAVAILABLE, retryable, because
 *   nothing about the request caused it.
 */
export function killedCommandError(input: KilledCommandInput): StudixError {
  const { subject, timeoutSeconds, maxTimeoutSeconds, durationMs } = input;
  const details = { ...input.details, killed: true, timeoutSeconds, durationMs };
  if (reachedTimeout(durationMs, timeoutSeconds)) {
    const lighter =
      "render at a lower resolution or fps, or split the work into shorter parts and run each separately.";
    return new StudixError("TIMEOUT", `${subject} was killed after ${timeoutSeconds}s timeout`, {
      retryable: false,
      details: { ...details, reason: "timeout" },
      suggestedAction:
        timeoutSeconds < maxTimeoutSeconds
          ? `Raise timeoutSeconds (max ${maxTimeoutSeconds}), or ${lighter}`
          : `It already ran for the maximum timeout: ${lighter}`,
    });
  }
  return new StudixError(
    "UNAVAILABLE",
    `${subject} was killed after ${Math.round(durationMs / 1000)}s, before its ${timeoutSeconds}s timeout: the sandbox stopped or lost the session`,
    {
      retryable: true,
      details: { ...details, reason: "sandbox-lost" },
      suggestedAction: "Run it again; if it keeps happening, check the worker's sandbox runner.",
    },
  );
}
