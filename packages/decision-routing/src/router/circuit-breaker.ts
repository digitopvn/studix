import type { Clock } from "@studix/shared";
import type { DecisionFailureReason } from "../decision-types.ts";

export interface CircuitBreakerOptions {
  /** Consecutive provider failures that open the circuit. Default 5. */
  failureThreshold?: number;
  /** How long an open circuit skips the provider before allowing a trial call. Default 30s. */
  cooldownMs?: number;
}

/** Failures that say something about provider health (not about the request or the caller). */
const HEALTH_FAILURES: ReadonlySet<DecisionFailureReason> = new Set([
  "timeout",
  "rate_limited",
  "unavailable",
  "provider_error",
  "auth",
]);

interface CircuitState {
  consecutiveFailures: number;
  openUntil: number;
}

/**
 * Per-provider consecutive-failure breaker. After `failureThreshold` failures the provider is skipped
 * for `cooldownMs`; afterwards one trial call is allowed, and a further failure re-opens it immediately.
 */
export class CircuitBreaker {
  readonly #states = new Map<string, CircuitState>();
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #clock: Clock;

  constructor(clock: Clock, options: CircuitBreakerOptions = {}) {
    this.#clock = clock;
    this.#threshold = Math.max(1, Math.floor(options.failureThreshold ?? 5));
    this.#cooldownMs = Math.max(0, options.cooldownMs ?? 30_000);
  }

  isOpen(providerId: string): boolean {
    const state = this.#states.get(providerId);
    return state !== undefined && this.#clock.now().getTime() < state.openUntil;
  }

  recordSuccess(providerId: string): void {
    this.#states.delete(providerId);
  }

  recordFailure(providerId: string, reason: DecisionFailureReason): void {
    if (!HEALTH_FAILURES.has(reason)) return;
    const state = this.#states.get(providerId) ?? { consecutiveFailures: 0, openUntil: 0 };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.#threshold) {
      state.openUntil = this.#clock.now().getTime() + this.#cooldownMs;
    }
    this.#states.set(providerId, state);
  }
}
