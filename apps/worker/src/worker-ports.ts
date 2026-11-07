import { join } from "node:path";
import {
  type ClaudeAgentTransport,
  createClaudeCodeCliTransport,
  createClaudeRoutingTransport,
  createClaudeSdkTransport,
  createFilesystemSkillBundleSource,
  createPiKeyTester,
  isRuntimeKeyProvider,
  preflightClaudeRuntime,
} from "@studix/agent-runtime";
import {
  createAnthropicKeyTester,
  createPlatformCredentialService,
  createProviderConnectionService,
  createSecretBox,
  createStorageProfileService,
  createWorkspaceFeatureService,
  liveStorageCredentials,
  type ProviderConnectionService,
  parseSecretKey,
  routeKeyTester,
  STORAGE_KEY_NAMES,
  type WorkspaceFeatureService,
} from "@studix/auth";
import { createDefaultApprovalPolicy } from "@studix/core";
import { createRepositories } from "@studix/database";
import {
  createDecisionRouterFromConfig,
  type DecisionProvider,
  type ProviderExecutionSink,
  RulesAdapter,
} from "@studix/decision-routing";
import { createEnvSecretResolver, createMcpGateway, loadGatewayConfig } from "@studix/mcp-gateway";
import { createActivityRecorder } from "@studix/observability";
import { MULTIX_VENDOR_KEYS } from "@studix/providers";
import { HyperFramesRenderer, renderToolchain } from "@studix/renderers";
import { StudixError } from "@studix/shared";
import { createExternalSkillService, createSkillBundleSource } from "@studix/skills";
import { createProfileStorageRouterFromConfig } from "@studix/storage";
import { createWorkerAgentHarness, type WorkerAgentHarness } from "./agent-harness.ts";
import { platformCredentials } from "./pack-services.ts";
import { type BrandLookup, createGatewayBrandLookup } from "./planner/brand-lookup-enrichment.ts";
import { registerBriefRule } from "./planner/brief-decision.ts";
import { type ClaudePlanner, createClaudePlanner, createPlannerRouter } from "./planner/claude-planner.ts";
import { prepareClaudeSandboxRoot } from "./planner/claude-sandbox.ts";
import { createExecutionSink } from "./planner/execution-sink.ts";
import { createVideoPlanner } from "./planner/video-planner.ts";
import { createWorkspaceModelDecisions } from "./planner/workspace-model-decisions.ts";
import { createSkillSandbox, loadSandboxSettings, type SkillSandbox } from "./skill-sandbox.ts";
import type { WorkerPorts } from "./wiring.ts";
import type { WorkerPortsRuntime } from "./worker-process.ts";
import type { WorkerSettings } from "./worker-settings.ts";

/** Covers the runtime's interrupt-then-kill sequence for runs aborted by shutdown. */
const CLAUDE_SHUTDOWN_GRACE_MS = 15_000;
/**
 * Longest a Claude session may live before a worker starting on the same host removes its sandbox. Agent
 * stages double their timeout with every approved overrun, so this is well above any single stage run.
 */
const CLAUDE_SANDBOX_MAX_SESSION_MS = 6 * 3_600_000;

/** Brand lookup through the workspace's MCP connectors, built only when STUDIX_BRAND_LOOKUP_TOOL is set. */
function gatewayBrandLookup(settings: WorkerSettings, runtime: WorkerPortsRuntime): BrandLookup | undefined {
  if (!settings.brandLookupTool) return undefined;
  const { logger } = runtime;
  const repos = createRepositories(runtime.db);
  const gateway = createMcpGateway({
    connectors: repos.connectors,
    approvals: repos.approvals,
    audit: repos.audit,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: settings.approvalCostThresholdCents }),
    secrets: createEnvSecretResolver({ env: runtime.env }),
    activity: createActivityRecorder(repos.activity, { logger }),
    config: loadGatewayConfig(runtime.env),
    logger: logger.child({ component: "mcp-gateway" }),
  });
  return createGatewayBrandLookup({ gateway, tool: settings.brandLookupTool, logger });
}

/**
 * The provider-connection service over the same master key as the app, or undefined without
 * STUDIX_SECRETS_KEY (then no workspace can have stored a key). A run re-tests a rejected key with the
 * provider's own tester before marking it invalid.
 */
export function providerConnections(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
): ProviderConnectionService | undefined {
  const { config } = settings;
  if (!config.STUDIX_SECRETS_KEY) return undefined;
  const repos = createRepositories(runtime.db);
  return createProviderConnectionService({
    connections: repos.providerConnections,
    audit: repos.audit,
    tester: routeKeyTester(
      createAnthropicKeyTester({ baseUrl: config.ANTHROPIC_BASE_URL }),
      createPiKeyTester(),
    ),
    isSupportedProvider: isRuntimeKeyProvider,
    secrets: createSecretBox(
      parseSecretKey(config.STUDIX_SECRETS_KEY),
      config.STUDIX_SECRETS_KEYS_PREVIOUS.map(parseSecretKey),
    ),
    claudeSubscription: async (ctx) =>
      (await workspaceFeatures(settings, runtime).effective(ctx)).claudeSubscription,
    mediaKeyNames: MULTIX_VENDOR_KEYS,
    logger: runtime.logger,
  });
}

/** Env flags plus each workspace owner's switch (self-hosted only), read per job. */
function workspaceFeatures(settings: WorkerSettings, runtime: WorkerPortsRuntime): WorkspaceFeatureService {
  const { config } = settings;
  return createWorkspaceFeatureService({
    settings: createRepositories(runtime.db).workspaceSettings,
    selfHosted: config.STUDIX_SELF_HOSTED,
    operator: {
      claudePlanner: config.STUDIX_CLAUDE_PLANNER,
      claudeSubscription: config.STUDIX_CLAUDE_SUBSCRIPTION,
    },
  });
}

/**
 * Models chosen in Settings → AI & Providers, run on the Pi runtime with the chosen connection, in front
 * of the operator router. Without stored keys the operator router runs alone.
 */
function withWorkspaceModels(
  operator: DecisionProvider,
  rules: RulesAdapter,
  providers: ProviderConnectionService | undefined,
  sink: ProviderExecutionSink,
  runtime: WorkerPortsRuntime,
): DecisionProvider {
  if (!providers) return operator;
  const repos = createRepositories(runtime.db);
  return createWorkspaceModelDecisions({
    operator,
    rules,
    jobs: repos.jobs,
    credentials: providers,
    preferences: repos.modelPreferences,
    snapshots: repos.modelSnapshots,
    sink,
    logger: runtime.logger,
  });
}

/**
 * The Claude transport shared by the Claude planner and the agent harness, built only when
 * STUDIX_CLAUDE_PLANNER is on (the flag means this host can run the Claude process). API keys run through
 * the Claude Agent SDK; with STUDIX_CLAUDE_SUBSCRIPTION a user's own subscription runs only through the
 * Claude Code executable the preflight found, invoked directly and never through the SDK.
 */
function claudeTransport(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
  executable: string | undefined,
): ClaudeAgentTransport | undefined {
  const claude = settings.claudePlanner;
  if (!claude) return undefined;
  // A session never outlives its deadline plus the runtime's interrupt-then-kill grace.
  const sandboxRoot = prepareClaudeSandboxRoot(
    join(settings.workDir, "claude"),
    Math.max(claude.timeoutMs, CLAUDE_SANDBOX_MAX_SESSION_MS) + 60_000,
    runtime.logger,
  );
  const apiKey = createClaudeSdkTransport({ baseUrl: settings.config.ANTHROPIC_BASE_URL, sandboxRoot });
  const { config } = settings;
  if (!(config.STUDIX_CLAUDE_SUBSCRIPTION || config.STUDIX_SELF_HOSTED) || !executable) return apiKey;
  return createClaudeRoutingTransport({
    apiKey,
    subscription: createClaudeCodeCliTransport({ executable, sandboxRoot }),
  });
}

/**
 * Claude Agent SDK planner, built only when STUDIX_CLAUDE_PLANNER is on. It opens the job's selected
 * Anthropic key through the same service and master key as the app; nothing else is ever substituted.
 */
function claudePlanner(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
  providers: ProviderConnectionService | undefined,
  transport: ClaudeAgentTransport | undefined,
): ClaudePlanner | undefined {
  const claude = settings.claudePlanner;
  if (!claude || !transport) return undefined;
  // loadWorkerSettings refuses the flag without STUDIX_SECRETS_KEY.
  if (!providers) throw new StudixError("INTERNAL", "STUDIX_CLAUDE_PLANNER needs STUDIX_SECRETS_KEY");
  const repos = createRepositories(runtime.db);
  return createClaudePlanner({
    transport,
    credentials: providers,
    executions: repos.usage,
    ...claude,
    logger: runtime.logger,
  });
}

/**
 * The in-worker harness for agent stages in `harness` mode, on each job's own provider connection: the Pi
 * runtime, or Claude when the worker runs it. Without STUDIX_SECRETS_KEY no workspace can have a key, so
 * there is no harness and those stages fail UNAVAILABLE with a pointer to host mode.
 */
function agentHarness(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
  providers: ProviderConnectionService | undefined,
  transport: ClaudeAgentTransport | undefined,
  sandbox?: SkillSandbox,
): WorkerAgentHarness | undefined {
  if (!providers) return undefined;
  const repos = createRepositories(runtime.db);
  return createWorkerAgentHarness({
    credentials: providers,
    preferences: repos.modelPreferences,
    snapshots: repos.modelSnapshots,
    executions: repos.usage,
    ...(transport && settings.claudePlanner
      ? { claude: { transport, plannerModel: settings.claudePlanner.model } }
      : {}),
    logger: runtime.logger,
    ...(sandbox
      ? { piWorkspace: (stage) => sandbox.forStage(stage), codex: { defaultModel: settings.codexModel } }
      : {}),
  });
}

/**
 * The skill sandbox (STUDIX_SANDBOX=docker) with the enabled skills of each tenant: from a local directory
 * when STUDIX_SANDBOX_SKILLS_DIR is set, else from the skill store.
 */
async function skillSandbox(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
  providers: ProviderConnectionService | undefined,
  storage: ReturnType<typeof createProfileStorageRouterFromConfig>,
): Promise<SkillSandbox | undefined> {
  const sandbox = loadSandboxSettings(runtime.env);
  if (!sandbox) return undefined;
  const repos = createRepositories(runtime.db);
  const skills = sandbox.skillsDir
    ? createFilesystemSkillBundleSource(sandbox.skillsDir)
    : createSkillBundleSource({
        repository: repos.externalSkills,
        service: createExternalSkillService({ repository: repos.externalSkills, storage }),
        logger: runtime.logger,
      });
  const credentials = platformCredentials(settings, runtime);
  return createSkillSandbox({
    settings: sandbox,
    workDir: settings.workDir,
    skills,
    keys: {
      ...(providers ? { workspace: (ctx) => providers.resolveMediaKeys(ctx) } : {}),
      ...(credentials ? { platform: async () => (await credentials.loadValues()).values } : {}),
      env: runtime.env,
    },
    logger: runtime.logger,
  });
}

/**
 * With STUDIX_CLAUDE_PLANNER on, refuse to start when the Claude process cannot run on this host (no SDK
 * binary for the platform, a libc mismatch), instead of failing every Claude job until its attempts run out.
 */
async function assertClaudeRuntime(
  settings: WorkerSettings,
  logger: WorkerPortsRuntime["logger"],
): Promise<string | undefined> {
  if (!settings.claudePlanner) return undefined;
  const check = await preflightClaudeRuntime();
  if (!check.ok && !settings.config.STUDIX_CLAUDE_PLANNER) {
    // Self-hosted without the env flag: Claude stays off on this host instead of blocking the worker.
    logger.warn("Claude runtime unavailable; Claude jobs will fail until it is installed", {
      reason: check.reason,
    });
    return undefined;
  }
  if (!check.ok) {
    throw new StudixError("UNAVAILABLE", `STUDIX_CLAUDE_PLANNER is on but ${check.reason}`, {
      retryable: false,
      suggestedAction:
        "Run the worker on a platform the Claude Agent SDK ships a binary for, or unset STUDIX_CLAUDE_PLANNER.",
    });
  }
  logger.info("Claude runtime ready", {
    executable: check.executable,
    version: check.version,
    subscriptions: settings.config.STUDIX_CLAUDE_SUBSCRIPTION
      ? "on"
      : settings.config.STUDIX_SELF_HOSTED
        ? "per-workspace"
        : "off",
  });
  return check.executable;
}

/**
 * A storage key pair an operator stored in the dashboard wins over S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY and
 * is followed live. Without STUDIX_SECRETS_KEY nothing stored can be opened, so the environment pair is used.
 */
function storageCredentialOverride(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
): { credentials?: ReturnType<typeof liveStorageCredentials> } {
  const { config } = settings;
  if (!config.STUDIX_SECRETS_KEY) return {};
  const repos = createRepositories(runtime.db);
  const store = createPlatformCredentialService({
    credentials: repos.platformCredentials,
    audit: repos.audit,
    secrets: createSecretBox(
      parseSecretKey(config.STUDIX_SECRETS_KEY),
      config.STUDIX_SECRETS_KEYS_PREVIOUS.map(parseSecretKey),
    ),
    allowedNames: STORAGE_KEY_NAMES,
    env: runtime.env,
    logger: runtime.logger,
  });
  return { credentials: liveStorageCredentials(store, config) };
}

/** Storage profiles an operator manages from the dashboard, read with the app's master key. */
function storageProfiles(settings: WorkerSettings, runtime: WorkerPortsRuntime) {
  const { config } = settings;
  if (!config.STUDIX_SECRETS_KEY) return {};
  const repos = createRepositories(runtime.db);
  const profiles = createStorageProfileService({
    profiles: repos.storageProfiles,
    audit: repos.audit,
    secrets: createSecretBox(
      parseSecretKey(config.STUDIX_SECRETS_KEY),
      config.STUDIX_SECRETS_KEYS_PREVIOUS.map(parseSecretKey),
    ),
    // The worker never saves a profile; these only guard writes made through the app.
    checkEndpoint: () => Promise.reject(new Error("read only")),
    checkKeyPrefix: () => {},
    logger: runtime.logger,
  });
  return { profiles, locate: repos.storageProfiles.locate };
}

/**
 * Production adapters for the standalone worker: S3-compatible storage, the HyperFrames renderer and
 * the brief planner (DecisionRouter for `video.brief` with a deterministic rules fallback, optional
 * connector brand lookup). Misconfiguration (no bucket, bad decision routes) fails startup loudly.
 */
export async function loadWorkerPorts(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
): Promise<WorkerPorts> {
  const { config } = settings;
  const { logger } = runtime;
  const storage = createProfileStorageRouterFromConfig(config, {
    ...storageCredentialOverride(settings, runtime),
    ...storageProfiles(settings, runtime),
    logger: logger.child({ component: "storage" }),
  });
  const toolchain = renderToolchain(runtime.env);
  if (!toolchain.ok) {
    logger.warn("render toolchain incomplete; render stages will fail until it is installed", {
      reason: toolchain.reason,
    });
  }
  const renderer = new HyperFramesRenderer({
    ffmpegPath: config.FFMPEG_PATH,
    ffprobePath: config.FFPROBE_PATH,
    logger: logger.child({ component: "hyperframes-renderer" }),
  });
  const claudeExecutable = await assertClaudeRuntime(settings, logger);
  const rules = registerBriefRule(new RulesAdapter({ logger }));
  const { usage } = createRepositories(runtime.db);
  const sink = createExecutionSink(usage);
  const providers = providerConnections(settings, runtime);
  const decisions = withWorkspaceModels(
    createDecisionRouterFromConfig(runtime.env, { rules, logger, sink }),
    rules,
    providers,
    sink,
    runtime,
  );
  const brandLookup = gatewayBrandLookup(settings, runtime);
  logger.info("worker adapters ready", {
    storage: "s3",
    renderer: renderer.id,
    brandLookup: settings.brandLookupTool ?? "off",
    claudePlanner: settings.claudePlanner ? settings.claudePlanner.model : "off",
    workspaceModels: providers ? "on" : "off",
    agentHarness: providers ? (settings.claudePlanner ? "pi+claude" : "pi") : "off",
  });
  const transport = claudeTransport(settings, runtime, claudeExecutable);
  const claude = claudePlanner(settings, runtime, providers, transport);
  const sandbox = await skillSandbox(settings, runtime, providers, storage);
  const harness = agentHarness(settings, runtime, providers, transport, sandbox);
  return {
    planner: createPlannerRouter({
      default: createVideoPlanner({ decisions, brandLookup, logger }),
      claude,
      ...(config.STUDIX_CLAUDE_PLANNER
        ? {}
        : {
            claudeEnabled: async (tenant) =>
              (await workspaceFeatures(settings, runtime).effective(tenant)).claudePlanner,
          }),
    }),
    renderer,
    storage,
    ...(harness ? { agentRuntimeFor: (stage) => harness.runtimeFor(stage) } : {}),
    close: async () => {
      // Shutdown stops waiting on stages at once; let aborted agent runs finish killing their process.
      const idle = await Promise.all([
        claude ? claude.idle(CLAUDE_SHUTDOWN_GRACE_MS) : true,
        harness ? harness.idle(CLAUDE_SHUTDOWN_GRACE_MS) : true,
      ]);
      if (idle.includes(false)) {
        logger.warn("agent runs still closing at shutdown", { graceMs: CLAUDE_SHUTDOWN_GRACE_MS });
      }
      await storage.destroy();
    },
  };
}
