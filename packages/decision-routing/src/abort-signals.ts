import { decisionError } from "./decision-errors.ts";

/**
 * Deadline handling shared by adapters and the router. A call is bounded by the caller's signal and by
 * its own timeout; whichever fires first decides whether the failure is CANCELLED or TIMEOUT.
 */

export interface Deadline {
  /** Fires when either the caller cancels or the timeout elapses. */
  signal: AbortSignal;
  /** True when the timeout (not the caller) ended the call. */
  timedOut(): boolean;
  /** Release the timer (call in `finally`). */
  dispose(): void;
}

export function createDeadline(timeoutMs: number, callerSignal?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Deadline of ${timeoutMs}ms exceeded`, "TimeoutError"));
  }, timeoutMs);
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/** The error a deadline produces once its signal has fired. */
export function deadlineError(deadline: Deadline, timeoutMs: number) {
  return deadline.timedOut()
    ? decisionError("TIMEOUT", "timeout", `Decision timed out after ${timeoutMs}ms`)
    : decisionError("CANCELLED", "cancelled", "Decision was cancelled by the caller", { retryable: false });
}

/**
 * Settle with `work`, or reject as soon as `signal` aborts. Guarantees the deadline is honored even
 * when the underlying work ignores its signal (for example a synchronous rule or a stuck socket).
 */
export function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Sleep that rejects with the signal's reason when aborted. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
