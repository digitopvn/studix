import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createApiKeyService, createDashboardAuth } from "@studix/auth";
import { createDefaultApprovalPolicy, StudioService } from "@studix/core";
import { createDb, createRepositories, migrate } from "@studix/database";
import { createActivityRecorder } from "@studix/observability";
import {
  allowedHosts,
  createLogger,
  type Logger,
  loadConfig,
  registerSecretsFromEnv,
  type StudixConfig,
  StudixError,
  systemClock,
} from "@studix/shared";
import type { Express } from "express";
import { z } from "zod";
import type { AppDeps } from "./app-deps.ts";
import { createApp } from "./create-app.ts";
import type {
  ArtifactUrlSigner,
  ConnectorAdmin,
  ReadinessCheck,
  RegisterMetaTools,
  SkillSummary,
} from "./ports.ts";

/** App-role settings that are not part of the shared config schema. */
export const AppEnvSchema = z.object({
  STUDIX_ROLE: z.enum(["app", "worker"]).optional(),
  STUDIX_MIGRATE_ON_START: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** Built dashboard directory (default: apps/dashboard/dist next to this app). */
  STUDIX_DASHBOARD_DIST: z.string().min(1).optional(),
  /** Reverse-proxy hops to trust for the client IP (0 = none). Set 1 behind the TOSE ingress. */
  STUDIX_TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
});
export type AppEnv = z.output<typeof AppEnvSchema>;

/** Adapters owned by other packages, plugged in at wiring time. */
export interface ComposeOverrides {
  storage?: ArtifactUrlSigner;
  connectors?: ConnectorAdmin;
  metaTools?: RegisterMetaTools;
  readiness?: ReadinessCheck[];
  skills?: SkillSummary[];
  logger?: Logger;
}

export interface ComposedApp {
  app: Express;
  config: StudixConfig;
  appEnv: AppEnv;
  logger: Logger;
  close(): Promise<void>;
}

/** The deterministic template the planner falls back to (ADR-0003); listed until a skills registry is wired. */
export const DEFAULT_SKILLS: SkillSummary[] = [
  {
    id: "brand-intro",
    title: "Brand intro",
    description: "Short motion-graphics brand introduction: logo, slogan, palette, 9:16 / 16:9 / 1:1.",
  },
];

const DEFAULT_DASHBOARD_DIST = fileURLToPath(new URL("../../dashboard/dist", import.meta.url));

function parseAppEnv(env: NodeJS.ProcessEnv): AppEnv {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const parsed = AppEnvSchema.safeParse(cleaned);
  if (parsed.success) return parsed.data;
  throw new StudixError(
    "VALIDATION",
    `Invalid configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
  );
}

/** Media origins for the dashboard CSP: the S3 endpoint, plus its subdomains for virtual-hosted buckets. */
function storageMediaOrigins(config: StudixConfig): string[] {
  if (!config.S3_ENDPOINT) return [];
  const url = new URL(config.S3_ENDPOINT);
  return config.S3_FORCE_PATH_STYLE ? [url.origin] : [url.origin, `${url.protocol}//*.${url.host}`];
}

function dashboardSecret(config: StudixConfig, logger: Logger): string {
  if (config.BETTER_AUTH_SECRET) return config.BETTER_AUTH_SECRET;
  if (config.NODE_ENV === "production") {
    throw new StudixError("VALIDATION", "BETTER_AUTH_SECRET is required in production");
  }
  logger.warn("BETTER_AUTH_SECRET is not set; using an ephemeral secret (sessions end on restart)");
  return randomBytes(32).toString("base64url");
}

/**
 * Build the app from environment variables: config, optional migrations, Postgres repositories, StudioService,
 * API keys and Better Auth. The caller owns `listen` and must call `close()` on shutdown.
 */
export async function composeApp(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ComposeOverrides = {},
): Promise<ComposedApp> {
  const config = loadConfig(env);
  const appEnv = parseAppEnv(env);
  registerSecretsFromEnv(env);
  const logger = overrides.logger ?? createLogger({ service: "studix-app" }, { level: config.LOG_LEVEL });
  if (appEnv.STUDIX_ROLE && appEnv.STUDIX_ROLE !== "app") {
    throw new StudixError("VALIDATION", `This process serves STUDIX_ROLE=app, got ${appEnv.STUDIX_ROLE}`);
  }
  if (!config.DATABASE_URL) throw new StudixError("VALIDATION", "DATABASE_URL is required");

  if (appEnv.STUDIX_MIGRATE_ON_START) {
    logger.info("applying database migrations");
    await migrate(config.DATABASE_URL);
  }
  const handle = createDb(config.DATABASE_URL, { applicationName: "studix-app" });
  const repos = createRepositories(handle.db, { clock: systemClock });
  const studio = new StudioService({
    ...repos,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: config.APPROVAL_COST_THRESHOLD_CENTS }),
    clock: systemClock,
    logger,
    defaults: {
      jobBudgetCents: config.DEFAULT_JOB_BUDGET_CENTS,
      jobDeadlineMs: config.DEFAULT_JOB_DEADLINE_SECONDS * 1000,
      jobMaxAttempts: config.JOB_MAX_ATTEMPTS,
    },
  });
  const dashboardAuth = createDashboardAuth({
    db: handle.db,
    directory: repos.directory,
    secret: dashboardSecret(config, logger),
    baseUrl: config.STUDIX_APP_URL,
    trustedOrigins: [config.STUDIX_PUBLIC_URL],
    ipAddressHeaders: appEnv.STUDIX_TRUST_PROXY > 0 ? ["x-forwarded-for"] : undefined,
    logger,
  });
  const apiKeys = createApiKeyService({
    directory: repos.directory,
    apiKeys: repos.apiKeys,
    env: config.STUDIX_API_KEY_ENV,
    logger,
  });

  const deps: AppDeps = {
    logger,
    publicUrl: config.STUDIX_PUBLIC_URL,
    appUrl: config.STUDIX_APP_URL,
    allowedHosts: allowedHosts(config),
    studio,
    repos,
    apiKeys,
    dashboardAuth,
    limits: {
      defaultJobBudgetCents: config.DEFAULT_JOB_BUDGET_CENTS,
      defaultJobDeadlineSeconds: config.DEFAULT_JOB_DEADLINE_SECONDS,
      approvalCostThresholdCents: config.APPROVAL_COST_THRESHOLD_CENTS,
      signedUrlTtlSeconds: config.S3_SIGNED_URL_TTL_SECONDS,
    },
    storage: overrides.storage,
    connectors: overrides.connectors,
    metaTools: overrides.metaTools,
    activity: createActivityRecorder(repos.activity, { logger }),
    readiness: [
      {
        name: "database",
        check: async () => {
          await handle.client`select 1`;
        },
      },
      ...(overrides.readiness ?? []),
    ],
    skills: overrides.skills ?? DEFAULT_SKILLS,
    dashboardDist: appEnv.STUDIX_DASHBOARD_DIST ?? DEFAULT_DASHBOARD_DIST,
    mediaOrigins: storageMediaOrigins(config),
    trustProxy: appEnv.STUDIX_TRUST_PROXY,
  };
  if (!overrides.storage) logger.warn("artifact storage not wired; playback URLs are unavailable");

  return { app: createApp(deps), config, appEnv, logger, close: () => handle.close() };
}
