import type { Server } from "node:http";
import { createLogger, toStudixError } from "@studix/shared";
import { composeApp } from "./compose-app.ts";

/**
 * `STUDIX_ROLE=app` entry point: compose from the environment, listen on PORT, stop cleanly on SIGTERM/SIGINT.
 * Storage, connectors and meta-tools are wired here once their packages are integrated (see ComposeOverrides).
 */
async function main(): Promise<void> {
  const composed = await composeApp(process.env);
  const { app, config, logger } = composed;

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(config.PORT, (error?: Error) => (error ? reject(error) : resolve(s)));
  });
  // Streamable HTTP responses are short (tools return fast); keep-alive above typical proxy idle timeouts.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  logger.info("studix app listening", { port: config.PORT, publicUrl: config.STUDIX_PUBLIC_URL });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(() => {
      composed
        .close()
        .catch((error: unknown) => logger.error("database close failed", { error: String(error) }))
        .finally(() => process.exit(0));
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  const err = toStudixError(error);
  createLogger({ service: "studix-app" }).error("startup failed", { code: err.code, error: err.message });
  process.exit(1);
});
