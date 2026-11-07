import type {
  ApiKeyService,
  ModelPreferenceService,
  ProviderConnectionService,
  WorkspaceFeatureService,
} from "@studix/auth";
import type {
  ActivityRepository,
  AgentHandoffService,
  JobRepository,
  RenderRepository,
  StudioService,
  WorkspaceRepository,
} from "@studix/core";
import type { RateLimitRepository } from "@studix/database";
import type { ActivityRecorder } from "@studix/observability";
import type { Logger } from "@studix/shared";
import type { ExternalSkillService } from "@studix/skills";
import type { TokenBucketOptions } from "./http/rate-limit.ts";
import type { PlatformSettingsService } from "./platform-settings.ts";
import type {
  ArtifactUrlSigner,
  ConnectorAdmin,
  DashboardAuthPort,
  ReadinessCheck,
  RegisterMetaTools,
  SkillSummary,
} from "./ports.ts";
import type { WorkspaceMultixApi } from "./workspace-multix.ts";

/** Product limits and defaults advertised by `studix_inspect` (values come from configuration). */
export interface AppLimits {
  defaultJobBudgetCents: number;
  defaultJobDeadlineSeconds: number;
  approvalCostThresholdCents: number;
  signedUrlTtlSeconds: number;
}

/** Everything `createApp` needs. All adapters are injected; nothing here reads the environment. */
export interface AppDeps {
  logger: Logger;
  /** Origin serving /mcp and /api (STUDIX_PUBLIC_URL). */
  publicUrl: string;
  /** Dashboard origin (STUDIX_APP_URL). */
  appUrl: string;
  /** Accepted Host header values (with or without port); see `allowedHosts()` in @studix/shared. */
  allowedHosts: string[];

  studio: StudioService;
  repos: {
    jobs: JobRepository;
    renders: RenderRepository;
    activity: ActivityRepository;
    workspaces: WorkspaceRepository;
  };
  apiKeys: ApiKeyService;
  dashboardAuth: DashboardAuthPort;
  limits: AppLimits;

  /** Artifact URL signing; without it playback URLs are reported as unavailable. */
  storage?: ArtifactUrlSigner;
  /** Workspace connectors (MCP-in-MCP); without it the connector API answers UNAVAILABLE. */
  connectors?: ConnectorAdmin;
  /** Outbound AI provider credentials; without it the provider API answers UNAVAILABLE. */
  providers?: ProviderConnectionService;
  /** Per-stage model choices for the Pi runtime; without it the model API answers UNAVAILABLE. */
  modelPreferences?: ModelPreferenceService;
  /** STUDIX_CLAUDE_PLANNER: jobs may select the Claude planner. */
  claudePlanner?: boolean;
  /**
   * Per-workspace Claude switches (env flags plus the owner's Dashboard switch on a self-hosted server).
   * When set it decides whether the Claude planner is on; `claudePlanner` is the fallback.
   */
  features?: WorkspaceFeatureService;
  /** Meta-tool registration hook from the gateway; without it the meta-tools are not listed. */
  metaTools?: RegisterMetaTools;
  /** Activity/trace recorder for MCP and API mutations (best effort). */
  activity?: ActivityRecorder;
  /** Checks run by /readyz (database ping, storage, ...). */
  readiness?: ReadinessCheck[];
  /** Workflow templates listed by `studix_inspect`. */
  skills?: SkillSummary[];
  /** Host-agent handoff of agent stages; without it the agent task tools answer UNAVAILABLE. */
  agentHandoffs?: AgentHandoffService;
  /** Imported GitHub skills; without it the skill tools answer UNAVAILABLE. */
  externalSkills?: ExternalSkillService;
  /** Storage & media settings for platform operators; without it the platform API answers UNAVAILABLE. */
  platform?: PlatformSettingsService;
  /** A workspace's Multix settings and status; without it the Multix API answers UNAVAILABLE. */
  multix?: WorkspaceMultixApi;

  /** Built dashboard directory; when missing, browser navigations get a 503 page. */
  dashboardDist?: string;
  /** Extra origins media may load from in the dashboard CSP (object storage). */
  /** Origins the dashboard may play media from; a function when storage profiles can change at runtime. */
  mediaOrigins?: string[] | (() => string[]);
  /** Express `trust proxy` setting (hop count) so rate limits see the client IP behind an ingress. */
  trustProxy?: number | boolean;
  /** Shared token-bucket store so limits hold across replicas; without it each process keeps its own buckets. */
  rateLimitStore?: RateLimitRepository;
  rateLimits?: {
    auth?: TokenBucketOptions;
    mcpIp?: TokenBucketOptions;
    mcp?: TokenBucketOptions;
    api?: TokenBucketOptions;
  };
}

export const SERVER_NAME = "studix";
export const SERVER_VERSION = "0.1.0";
