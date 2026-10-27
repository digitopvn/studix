import { createDb, type StudixDb } from "@studix/database";
import { createLogger, type Logger } from "@studix/shared";
import { databaseReady, waitForDatabase } from "./database-readiness.ts";
import { type HealthServer, startHealthServer } from "./health-server.ts";
import { createWorkerRuntime, type WorkerPorts, type WorkerRuntime } from "./wiring.ts";
import { loadWorkerSettings, type WorkerSettings } from "./worker-settings.ts";

/** Process resources handed to the port resolver (shared pool, environment, process logger). */
export interface WorkerPortsRuntime {
  db: StudixDb;
  env: NodeJS.ProcessEnv;
  logger: Logger;
}

export interface WorkerProcessOptions {
  /** Adapters for the stages, resolved once the settings are known and the database is ready. */
  resolvePorts: (settings: WorkerSettings, runtime: WorkerPortsRuntime) => Promise<WorkerPorts>;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Install SIGTERM/SIGINT handlers (default true; tests turn it off). */
  handleSignals?: boolean;
}

export interface WorkerProcess {
  settings: WorkerSettings;
  healthPort: number;
  /** Stop claiming, drain or release running jobs, close the health server and the pool. Idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Worker process lifecycle: health server first (live, not ready), wait for a migrated database,
 * resolve adapters, start N claim loops, then drain gracefully on SIGTERM.
 */
export async function runWorkerProcess(options: WorkerProcessOptions): Promise<WorkerProcess> {
  const settings = loadWorkerSettings(options.env);
  const logger = (
    options.logger ?? createLogger({ service: "studix-worker" }, { level: settings.config.LOG_LEVEL })
  ).child({
    workerId: settings.workerId,
  });
  const handle = createDb(settings.databaseUrl, {
    max: settings.concurrency + 2,
    applicationName: `studix-worker:${settings.workerId}`,
  });
  let runtime: WorkerRuntime | undefined;
  let ports: WorkerPorts | undefined;
  let stopping = false;
  const startup = new AbortController();

  const health: HealthServer = await startHealthServer({
    port: settings.healthPort,
    host: settings.healthHost,
    live: () => ({ ok: true, details: { workerId: settings.workerId } }),
    ready: async () => {
      const pool = runtime?.status();
      if (stopping || !pool?.running)
        return { ok: false, details: { reason: stopping ? "stopping" : "starting" } };
      const db = await databaseReady(handle).catch(() => false);
      return { ok: db, details: { database: db, activeJobs: pool.activeJobs } };
    },
  });
  logger.info("health server listening", { port: health.port });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      stopping = true;
      startup.abort();
      logger.info("shutting down worker");
      try {
        await runtime?.stop(settings.shutdownGraceMs);
      } finally {
        await ports?.close?.().catch((err) => logger.warn("adapter close failed", { error: String(err) }));
        await health
          .close()
          .catch((err) => logger.warn("health server close failed", { error: String(err) }));
        await handle.close().catch((err) => logger.warn("database close failed", { error: String(err) }));
        logger.info("worker stopped");
      }
    })();
    return shutdownPromise;
  };

  if (options.handleSignals ?? true) {
    const onSignal = (signal: NodeJS.Signals) => {
      if (stopping) {
        logger.warn("second signal received, exiting immediately", { signal });
        process.exit(1);
      }
      logger.info("signal received", { signal });
      shutdown().then(
        () => process.exit(0),
        (err) => {
          logger.error("shutdown failed", { error: String(err) });
          process.exit(1);
        },
      );
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  try {
    await waitForDatabase(handle, { logger, signal: startup.signal });
    ports = await options.resolvePorts(settings, {
      db: handle.db,
      env: options.env ?? process.env,
      logger,
    });
    if (stopping) throw new Error("worker stopped during startup");
    runtime = createWorkerRuntime({ ...ports, db: handle.db, settings, logger });
    runtime.start();
  } catch (err) {
    await shutdown();
    throw err;
  }
  return { settings, healthPort: health.port, shutdown };
}
