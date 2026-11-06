import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPiKeyTester, findPiModel, isRuntimeKeyProvider } from "@studix/agent-runtime";
import {
  createAnthropicKeyTester,
  createApiKeyService,
  createDashboardAuth,
  createLiveCredentialEnv,
  createModelPreferenceService,
  createPlatformCredentialService,
  createProviderConnectionService,
  createSecretBox,
  createWorkspaceFeatureService,
  parseSecretKey,
  routeKeyTester,
  withSelfHostedSecretsKey,
} from "@studix/auth";
import { createDefaultApprovalPolicy, StudioService } from "@studix/core";
import { createDb, createRepositories, migrate } from "@studix/database";
import { createActivityRecorder } from "@studix/observability";
import { createMultixProviderFromConfig, MULTIX_VENDOR_KEYS } from "@studix/providers";
import {
  allowedHosts,
  createLogger,
  type Logger,
  loadConfig,
  registerSecret,
  registerSecretsFromEnv,
  type StudixConfig,
  StudixError,
  ssoClients,
  systemClock,
} from "@studix/shared";
import type { ExternalSkillService } from "@studix/skills";
import type { Express } from "express";
import { z } from "zod";
import type { AppDeps } from "./app-deps.ts";
import { composeIntegrations, storageMediaOrigins } from "./compose-integrations.ts";
import { createApp } from "./create-app.ts";
import { createPlatformAdmin, storageSettingsFromConfig, VENDOR_CREDENTIAL_NAMES } from "./platform-admin.ts";
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
  /** Serve OAuth 2.1 on /mcp (default on). `false` keeps workspace API keys as the only way in. */
  STUDIX_MCP_OAUTH: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
});
export type AppEnv = z.output<typeof AppEnvSchema>;

/** Canonical resource identifier of the MCP endpoint: the audience every OAuth access token must carry. */
export function mcpResourceUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/mcp`;
}

/** Replacements for the adapters composeIntegrations builds from the environment (tests, embedding). */
export interface ComposeOverrides {
  storage?: ArtifactUrlSigner;
  connectors?: ConnectorAdmin;
  metaTools?: RegisterMetaTools;
  readiness?: ReadinessCheck[];
  skills?: SkillSummary[];
  externalSkills?: ExternalSkillService;
  logger?: Logger;
}

export interface ComposedApp {
  app: Express;
  config: StudixConfig;
  appEnv: AppEnv;
  logger: Logger;
  close(): Promise<void>;
}

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
  const config = withSelfHostedSecretsKey(loadConfig(env));
  if (config.STUDIX_SECRETS_KEY) registerSecret(config.STUDIX_SECRETS_KEY);
  const appEnv = parseAppEnv(env);
  registerSecretsFromEnv(env);
  // The env scan registers the comma-separated list as one value; each retired key is a secret on its own.
  for (const key of config.STUDIX_SECRETS_KEYS_PREVIOUS) registerSecret(key);
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
  const approvalPolicy = createDefaultApprovalPolicy({
    costThresholdCents: config.APPROVAL_COST_THRESHOLD_CENTS,
  });
  const activity = createActivityRecorder(repos.activity, { logger });
  const integrations = composeIntegrations({ env, config, repos, approvalPolicy, activity, logger });
  const secretBox = config.STUDIX_SECRETS_KEY
    ? createSecretBox(
        parseSecretKey(config.STUDIX_SECRETS_KEY),
        config.STUDIX_SECRETS_KEYS_PREVIOUS.map(parseSecretKey),
      )
    : undefined;
  // Media vendor keys: sealed rows the operator manages in the dashboard, over the process environment.
  const credentialEnv = createLiveCredentialEnv({
    credentials: repos.platformCredentials,
    secrets: secretBox,
    base: env,
    names: Object.values(MULTIX_VENDOR_KEYS),
    logger,
  });
  await credentialEnv.refresh().catch(() => undefined);
  const stopCredentialRefresh = credentialEnv.start();
  const multix = config.MULTIX_BIN
    ? createMultixProviderFromConfig(config, { env: credentialEnv.env })
    : undefined;
  const studio = new StudioService({
    ...repos,
    // Operators attach Atlas predictions by hand; each is checked with Atlas first, so this needs multix.
    providerJobs: multix,
    approvalPolicy,
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
    sso: ssoClients(config),
    mcpOAuth: appEnv.STUDIX_MCP_OAUTH ? { resource: mcpResourceUrl(config.STUDIX_PUBLIC_URL) } : undefined,
    ipAddressHeaders: appEnv.STUDIX_TRUST_PROXY > 0 ? ["x-forwarded-for"] : undefined,
    logger,
  });
  const apiKeys = createApiKeyService({
    directory: repos.directory,
    apiKeys: repos.apiKeys,
    env: config.STUDIX_API_KEY_ENV,
    logger,
  });
  const features = createWorkspaceFeatureService({
    settings: repos.workspaceSettings,
    audit: repos.audit,
    selfHosted: config.STUDIX_SELF_HOSTED,
    operator: {
      claudePlanner: config.STUDIX_CLAUDE_PLANNER,
      claudeSubscription: config.STUDIX_CLAUDE_SUBSCRIPTION,
    },
  });
  const providers = createProviderConnectionService({
    connections: repos.providerConnections,
    audit: repos.audit,
    // Anthropic keys keep the free /v1/models check; other providers get a one-cent Pi probe.
    tester: routeKeyTester(
      createAnthropicKeyTester({ baseUrl: config.ANTHROPIC_BASE_URL }),
      createPiKeyTester(),
    ),
    isSupportedProvider: isRuntimeKeyProvider,
    secrets: secretBox,
    claudeSubscription: async (ctx) => (await features.effective(ctx)).claudeSubscription,
    logger,
  });
  if (!config.STUDIX_SECRETS_KEY)
    logger.warn("STUDIX_SECRETS_KEY is not set; provider keys cannot be stored");
  const modelPreferences = createModelPreferenceService({
    preferences: repos.modelPreferences,
    providers,
    audit: repos.audit,
    knownModel: (provider, modelId) => findPiModel(provider, modelId) !== undefined,
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
    storage: overrides.storage ?? integrations.storage,
    connectors: overrides.connectors ?? integrations.connectors,
    metaTools: overrides.metaTools ?? integrations.metaTools,
    providers,
    modelPreferences,
    platform: createPlatformAdmin({
      operatorEmails: config.STUDIX_OPERATOR_EMAILS,
      credentials: createPlatformCredentialService({
        credentials: repos.platformCredentials,
        audit: repos.audit,
        secrets: secretBox,
        names: VENDOR_CREDENTIAL_NAMES,
        env,
      }),
      refreshCredentials: () => credentialEnv.refresh(),
      storage: integrations.storage,
      storageSettings: storageSettingsFromConfig(config),
      multix,
      multixBin: config.MULTIX_BIN,
    }),
    claudePlanner: config.STUDIX_CLAUDE_PLANNER,
    features,
    activity,
    readiness: [
      {
        name: "database",
        check: async () => {
          await handle.client`select 1`;
        },
      },
      ...(overrides.readiness ?? []),
    ],
    skills: overrides.skills ?? integrations.skills,
    agentHandoffs: integrations.agentHandoffs,
    externalSkills: overrides.externalSkills ?? integrations.externalSkills,
    dashboardDist: appEnv.STUDIX_DASHBOARD_DIST ?? DEFAULT_DASHBOARD_DIST,
    mediaOrigins: storageMediaOrigins(config),
    trustProxy: appEnv.STUDIX_TRUST_PROXY,
    rateLimitStore: repos.rateLimits,
  };
  let closed = false;
  if (!deps.storage) logger.warn("S3_BUCKET is not set; playback URLs are unavailable");
  else if (!overrides.storage && integrations.storage) {
    // Surface a rejected bucket credential at startup instead of when the first render fails to upload.
    void integrations.storage.probeWrite().then((probe) => {
      if (closed) return;
      if (probe.ok) logger.info("object storage write probe passed");
      else {
        logger.error("object storage write probe failed; renders cannot be uploaded until it is fixed", {
          step: probe.step,
          status: probe.status,
          s3Code: probe.s3Code,
        });
      }
    });
  }

  const close = async () => {
    closed = true;
    stopCredentialRefresh();
    integrations.storage?.destroy();
    await handle.close();
  };
  return { app: createApp(deps), config, appEnv, logger, close };
}
