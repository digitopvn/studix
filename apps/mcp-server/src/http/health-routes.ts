import type { Logger } from "@studix/shared";
import type { Express } from "express";
import type { ReadinessCheck } from "../ports.ts";

const CHECK_TIMEOUT_MS = 3000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * `/healthz`: process liveness only (no dependencies). `/readyz`: every readiness check must pass; failures
 * report only the check names (details go to the log, not the response).
 */
export function mountHealthRoutes(
  app: Express,
  options: { version: string; checks: ReadinessCheck[]; logger: Logger },
): void {
  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ ok: true, version: options.version });
  });

  app.get("/readyz", async (_req, res) => {
    const results = await Promise.all(
      options.checks.map(async (c) => {
        try {
          await withTimeout(c.check(), CHECK_TIMEOUT_MS);
          return { name: c.name, ok: true };
        } catch (error) {
          options.logger.warn("readiness check failed", {
            check: c.name,
            error: error instanceof Error ? error.message : String(error),
          });
          return { name: c.name, ok: false };
        }
      }),
    );
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    res
      .status(failed.length === 0 ? 200 : 503)
      .set("Cache-Control", "no-store")
      .json({ ok: failed.length === 0, checks: results, ...(failed.length ? { failed } : {}) });
  });
}
