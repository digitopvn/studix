import type { DatabaseHandle } from "@studix/database";
import { type Logger, StudixError } from "@studix/shared";

/**
 * True when Postgres answers and the schema is migrated (the `jobs` table exists). The worker never runs
 * migrations itself; the app role does.
 */
export async function databaseReady(handle: DatabaseHandle, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const query = handle.client`select to_regclass('public.jobs') is not null as ready`;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        query.cancel();
        reject(new StudixError("TIMEOUT", "database readiness check timed out"));
      }, timeoutMs);
    });
    const rows = await Promise.race([query, timeout]);
    return rows[0]?.ready === true;
  } finally {
    clearTimeout(timer);
  }
}

/** Wait (with capped backoff) until the database is reachable and migrated, or the signal aborts. */
export async function waitForDatabase(
  handle: DatabaseHandle,
  options: { logger: Logger; signal?: AbortSignal; maxDelayMs?: number },
): Promise<void> {
  let delay = 250;
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      if (await databaseReady(handle)) return;
      options.logger.warn("database schema not migrated yet; waiting for the app role", { attempt });
    } catch (err) {
      options.logger.warn("database not reachable yet", {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, options.maxDelayMs ?? 5000);
  }
}
