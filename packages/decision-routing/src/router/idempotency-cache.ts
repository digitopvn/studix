import { createHash } from "node:crypto";
import { type Clock, StudixError } from "@studix/shared";

export interface IdempotencyCacheOptions {
  /** How long a completed decision is replayed for the same key. Default 10 minutes. */
  ttlMs?: number;
  /** Bound on remembered keys; oldest entries are evicted first. Default 1000. */
  maxEntries?: number;
}

interface Entry {
  fingerprint: string;
  promise: Promise<unknown>;
  /** Undefined while in flight. */
  expiresAt?: number;
}

/** JSON with sorted object keys, so equal inputs fingerprint equally regardless of key order. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
}

export function fingerprintOf(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value) ?? "undefined")
    .digest("hex");
}

/**
 * In-process idempotency for decisions: concurrent and repeated calls with the same key share one
 * provider call and one bill. Failures are not cached, so a retry with the same key runs again.
 * `replayed` tells the caller its result came from an earlier or concurrent call, so it can avoid billing
 * the same provider call again. Reusing a key with a different input is a CONFLICT. Durable, cross-process idempotency belongs to the
 * job layer that persists decision results.
 */
export class IdempotencyCache {
  readonly #entries = new Map<string, Entry>();
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(clock: Clock, options: IdempotencyCacheOptions = {}) {
    this.#clock = clock;
    this.#ttlMs = Math.max(0, options.ttlMs ?? 10 * 60_000);
    this.#maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 1000));
  }

  run<T>(key: string, fingerprint: string, work: () => Promise<T>): Promise<{ value: T; replayed: boolean }> {
    const now = this.#clock.now().getTime();
    const existing = this.#entries.get(key);
    if (existing && (existing.expiresAt === undefined || existing.expiresAt > now)) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new StudixError("CONFLICT", "Idempotency key was reused with a different decision input", {
            retryable: false,
            suggestedAction: "Use a new idempotency key for a different decision.",
          }),
        );
      }
      return (existing.promise as Promise<T>).then((value) => ({ value, replayed: true }));
    }
    this.#entries.delete(key);
    const entry: Entry = { fingerprint, promise: Promise.resolve() };
    const promise = work().then(
      (value) => {
        entry.expiresAt = this.#clock.now().getTime() + this.#ttlMs;
        return value;
      },
      (error: unknown) => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
        throw error;
      },
    );
    entry.promise = promise;
    this.#entries.set(key, entry);
    this.#evict();
    return promise.then((value) => ({ value, replayed: false }));
  }

  #evict(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) return;
      this.#entries.delete(oldest);
    }
  }
}
