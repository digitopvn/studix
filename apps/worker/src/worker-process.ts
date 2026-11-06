import { createDb, type StudixDb } from "@studix/database";
import { createLogger, type Logger, registerSecret, registerSecretsFromEnv } from "@studix/shared";
import { databaseReady, waitForDatabase } from "./database-readiness.ts";
import { type HealthServer, startHealthServer } from "./health-server.ts";
import { createStorageReadiness, type StorageReadiness } from "./storage-readiness.ts";
import { createWorkerRuntime, type WorkerPorts, type WorkerRuntime } from "./wiring.ts";
import { sweepStaleJobDirs } from "./work-dir-sweep.ts";
import { loadWorkerSettings, type WorkerSettings } from "./worker-settings.ts";

/** Process resources handed to the port resolver (shared pool, environment, process logger). */
export interface WorkerPortsRuntime {
  db: StudixDb;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** Aborts when the worker is asked to stop while it is still starting. */
  signal: AbortSignal;
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
  const env = options.env ?? process.env;
  const settings = loadWorkerSettings(env);
  // Env secrets (database URL, STUDIX_SECRETS_KEY, provider keys) are redacted from every log line.
  registerSecretsFromEnv(env);
  for (const key of settings.config.STUDIX_SECRETS_KEYS_PREVIOUS) registerSecret(key);
  // A self-hosted worker may have read its master key from a file rather than the env scan above.
  if (settings.config.STUDIX_SECRETS_KEY) registerSecret(settings.config.STUDIX_SECRETS_KEY);
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
  let sweepTimer: NodeJS.Timeout | undefined;
  let storageReadiness: StorageReadiness | undefined;

  const health: HealthServer = await startHealthServer({
    port: settings.healthPort,
    host: settings.healthHost,
    live: () => ({ ok: true, details: { workerId: settings.workerId } }),
    ready: async () => {
      const pool = runtime?.status();
      if (stopping || !pool?.running)
        return { ok: false, details: { reason: stopping ? "stopping" : "starting" } };
      const db = await databaseReady(handle).catch(() => false);
      const storage = storageReadiness ? await storageReadiness.check() : undefined;
      return {
        ok: db && (storage?.ok ?? true),
        details: {
          database: db,
          ...(storage
            ? {
                storage: storage.ok,
                ...(storage.ok ? {} : { storageStep: storage.step, storageStatus: storage.status }),
              }
            : {}),
          activeJobs: pool.activeJobs,
        },
      };
    },
  });
  logger.info("health server listening", { port: health.port });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      stopping = true;
      startup.abort();
      if (sweepTimer) clearInterval(sweepTimer);
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
      env,
      logger,
      signal: startup.signal,
    });
    if (stopping) throw new Error("worker stopped during startup");
    storageReadiness = createStorageReadiness(ports.storage, logger);
    // Surface a bad bucket or credential now, not after a job has rendered. Not fatal: storage may recover.
    await storageReadiness.check();
    runtime = createWorkerRuntime({ ...ports, db: handle.db, settings, logger });
    runtime.start();
    const sweep = () =>
      sweepStaleJobDirs(settings.workDir, settings.workDirRetentionMs).then(
        (removed) => {
          if (removed.length > 0)
            logger.info("removed stale job work directories", { count: removed.length });
        },
        (err) => logger.warn("work directory sweep failed", { error: String(err) }),
      );
    void sweep();
    sweepTimer = setInterval(() => void sweep(), 3_600_000);
    sweepTimer.unref();
  } catch (err) {
    await shutdown();
    throw err;
  }
  return { settings, healthPort: health.port, shutdown };
}
