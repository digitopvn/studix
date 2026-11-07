/**
 * Typed client for the Studix dashboard JSON API. Same-origin only (`/api/*`); the session cookie is sent
 * automatically. Errors arrive as `{ error: { code, message, suggestedAction? } }`.
 */

const WORKSPACE_KEY = "studix.workspace";
const WORKSPACE_HEADER = "x-studix-workspace";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly suggestedAction?: string,
  ) {
    super(message);
  }
}

export function selectedWorkspace(): string | null {
  return localStorage.getItem(WORKSPACE_KEY);
}

export function selectWorkspace(id: string | null): void {
  if (id) localStorage.setItem(WORKSPACE_KEY, id);
  else localStorage.removeItem(WORKSPACE_KEY);
}

/** A workspace's own media vendor key (BYOK); `platform` means media calls use the platform key. */
export interface WorkspaceMediaKey {
  vendor: string;
  source: "workspace" | "platform";
  keyHint?: string;
  version?: number;
  updatedAt?: string;
}

export interface WorkspaceMediaKeys {
  storage: "available" | "unavailable";
  canManage: boolean;
  keys: WorkspaceMediaKey[];
}

/** What a workspace overrides; null (or a role left out) keeps the server's MULTIX_* value. */
export interface WorkspaceMultixValues {
  enabled: boolean | null;
  waitTimeoutSeconds: number | null;
  models: Record<string, string>;
  voiceLanguageModels: string | null;
}

export interface MultixEffective<T> {
  value: T;
  source: "workspace" | "server";
}

export interface WorkspaceMultixSettings {
  canChange: boolean;
  server: {
    enabled: boolean;
    waitTimeoutSeconds: number;
    models: Record<string, string>;
    voiceLanguageModels: string | null;
  };
  workspace: WorkspaceMultixValues | null;
  effective: {
    enabled: MultixEffective<boolean>;
    waitTimeoutSeconds: MultixEffective<number>;
    models: Record<string, MultixEffective<string>>;
    voiceLanguageModels: MultixEffective<string | null>;
  };
  updatedAt?: string;
}

/** The models each Multix role can be set to (GET /api/providers/multix/catalog). */
export interface MultixCatalogEntry {
  id: string;
  vendor: string;
  model: string;
  label?: string;
  capabilities?: string[];
}

export interface MultixCatalog {
  roles: Record<string, MultixCatalogEntry[]>;
  openVendors: string[];
  fetchedAt: string;
  errors: string[];
}

export interface WorkspaceMultixCheck {
  version: string | null;
  diagnosis: {
    state: "ready" | "missing_executable" | "check_failed";
    vendors: Record<string, boolean>;
    reason?: string;
    code?: string;
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const workspace = selectedWorkspace();
  if (workspace && !path.startsWith("/api/auth/")) headers[WORKSPACE_HEADER] = workspace;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Cannot reach the Studix server. Check your connection and retry.");
  }
  const text = await res.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  if (!res.ok) {
    const record = (payload ?? {}) as {
      error?: { code?: string; message?: string; suggestedAction?: string };
    };
    // Better Auth answers with { code, message } at the top level.
    const flat = (payload ?? {}) as { code?: string; message?: string };
    const error = record.error ?? flat;
    throw new ApiError(
      res.status,
      error.code ?? `HTTP_${res.status}`,
      error.message ?? res.statusText,
      record.error?.suggestedAction,
    );
  }
  return payload as T;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  organizationName: string;
  role: string;
}

export interface Me {
  user: { id: string; email: string; name: string };
  role: string;
  workspace?: { id: string; name: string };
  organization?: { id: string; name: string };
  workspaces: WorkspaceSummary[];
  mcpUrl: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface Project {
  id: string;
  title: string;
  status: string;
  brief: { prompt?: string; aspectRatio?: string; durationMs?: number; language?: string };
  createdAt: string;
  updatedAt: string;
}

export interface StudixErrorPayload {
  code: string;
  message: string;
  suggestedAction?: string;
}

export interface Stage {
  name: string;
  status: string;
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  error?: StudixErrorPayload;
  /** The stage used its template because the agent did not run, with the reason. */
  fallback?: string;
}

export interface Job {
  id: string;
  kind: string;
  status: string;
  projectId?: string;
  stage?: string;
  progress: number;
  spentCents?: number;
  attempts?: number;
  maxAttempts?: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: StudixErrorPayload;
  stages?: Stage[];
  approval?: { id: string; action: string; status: string; reason: string };
  budget?: { limitCents?: number; spentCents: number };
  video?: { renderId: string; url: string; expiresAt: string; preset: string };
  videoUnavailableReason?: string;
}

export interface ActivityEvent {
  id: string;
  name: string;
  level: string;
  message?: string;
  stage?: string;
  provider?: string;
  durationMs?: number;
  createdAt: string;
}

export interface RenderSummary {
  id: string;
  status: string;
  preset: string;
  jobId?: string;
  url?: string;
  urlExpiresAt?: string;
  createdAt: string;
}

export interface ProjectDetail {
  project: Project;
  currentVersion?: { id: string; version: number; source: string; createdAt: string };
  jobs: Job[];
  renders: RenderSummary[];
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  role: string;
  scopes: string[];
  status: "active" | "revoked" | "expired";
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

export interface Connector {
  id: string;
  name: string;
  url: string;
  status: "active" | "disabled" | "error";
  toolCount?: number;
  lastCheckedAt?: string;
  lastError?: string;
}

export type ProviderConnectionStatus = "available" | "invalid" | "unverified";

/** Pay-as-you-go access through an Anthropic Console API key, billed to the key's organization. */
export interface ApiKeyMethodInfo {
  authMethod: "api_key";
  title: string;
  billing: "usage_based";
  availability: "available" | "unavailable";
  reason?: string;
  canAddWorkspaceKey: boolean;
  canAddPersonalKey: boolean;
}

/**
 * Claude subscription: restricted on hosted servers; on a self-hosted server (STUDIX_CLAUDE_SUBSCRIPTION)
 * each user may connect their own token from `claude setup-token`, run only by the Claude Code binary.
 */
export interface SubscriptionMethodInfo {
  authMethod: "oauth_subscription";
  title: string;
  billing: "subscription";
  availability: "restricted" | "available" | "unavailable";
  reason: string;
  alternative: string;
  references: string[];
  canConnect: boolean;
}

export interface ProviderConnectionTest {
  ok: boolean;
  at: string;
  latencyMs: number;
  httpStatus?: number;
  error?: StudixErrorPayload & { retryable: boolean };
}

export type AgentRuntimeName = "claude" | "codex" | "pi";

/** A stored provider API key binding; the secret itself never leaves the server, only `keyHint`. */
export interface ProviderConnection {
  id: string;
  provider: string;
  authMethod: "api_key" | "oauth_subscription";
  billing: "usage_based" | "subscription" | "extra_usage" | "unknown";
  /** Agent runtimes allowed to spend this key; Anthropic keys start with `claude` only. */
  runtimes: AgentRuntimeName[];
  version: number;
  owner: "workspace" | "user";
  ownedByMe: boolean;
  label: string;
  status: ProviderConnectionStatus;
  keyHint?: string;
  lastTest?: ProviderConnectionTest;
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AnthropicProvider {
  provider: "anthropic";
  methods: [ApiKeyMethodInfo, SubscriptionMethodInfo];
  connections: ProviderConnection[];
  /** Jobs may select the Claude planner on this server. */
  claudePlanner: boolean;
}

export type PlatformSecretStatus = "configured" | "missing" | "invalid" | "unverified";

export interface PlatformStorageTest {
  ok: boolean;
  at: string;
  failedStep?: string;
  httpStatus?: number;
  s3Code?: string;
  diagnosis:
    | "ok"
    | "missing_credential"
    | "bad_credential"
    | "missing_permission"
    | "missing_bucket"
    | "remote_unavailable";
  message?: string;
  suggestedAction?: string;
}

export interface PlatformCredential {
  name: string;
  source: "dashboard" | "environment" | "missing";
  keyHint?: string;
  version?: number;
  updatedAt?: string;
  updatedBy?: { type: string; id: string };
  lastTest?: { ok: boolean; at: string; detail?: string };
}

export interface PlatformMediaKeyTest {
  name: string;
  at: string;
  verdict: "available" | "invalid" | "unverified";
  httpStatus?: number;
  note?: string;
}

export interface PlatformMediaVendor {
  vendor: string;
  keyName: string;
  kinds: string[];
  credential: PlatformCredential;
  status: "configured" | "missing" | "unverified";
}

export type StorageProviderType = "cloudflare-r2" | "aws-s3" | "s3-compatible";

/** `platform`: the operator's profiles; `workspace`: the session workspace's own (owners and admins). */
export type StorageProfileScope = "platform" | "workspace";

const profilesPath = (scope: StorageProfileScope, id?: string) =>
  `${scope === "platform" ? "/api/platform" : "/api/workspace-storage"}/storage/profiles${
    id === undefined ? "" : `/${encodeURIComponent(id)}`
  }`;

export interface StorageProfile {
  id: string;
  name: string;
  /** `environment`: the S3_* settings; `platform`: a workspace following the platform choice. */
  providerType: StorageProviderType | "environment" | "platform";
  endpointHost?: string;
  bucket?: string;
  region: string;
  forcePathStyle: boolean;
  keyPrefix: string;
  active: boolean;
  accessKeyHint?: string;
  secretHint?: string;
  version?: number;
  updatedAt?: string;
  updatedBy?: { type: string; id: string };
  lastTest?: { ok: boolean; at: string; detail?: string };
  references?: number;
}

export interface StorageProfileInput {
  name: string;
  providerType: StorageProviderType;
  endpoint?: string;
  bucket: string;
  region: string;
  forcePathStyle?: boolean;
  keyPrefix?: string;
  /** Required on create; on update both or neither (keep the stored pair). */
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface PlatformSettings {
  /** Absent when profiles cannot be stored (no STUDIX_SECRETS_KEY). */
  storageProfiles?: StorageProfile[];
  storage: {
    configured: boolean;
    source: "dashboard" | "environment";
    credentialStorage: "available" | "unavailable";
    credential?: PlatformCredential;
    endpointHost?: string;
    bucket?: string;
    region: string;
    pathStyle: boolean;
    signedUrlTtlSeconds: number;
    accessKeyId?: string;
    secretAccessKey: PlatformSecretStatus;
    lastTest?: PlatformStorageTest;
    changeNeedsRedeploy: boolean;
  };
  media: {
    executable: "configured" | "missing";
    path?: string;
    homeEnvDisabled: boolean;
    credentialStorage: "available" | "unavailable";
    vendors: PlatformMediaVendor[];
    lastCheck?: { at: string; state: string; reason?: string; code?: string };
    apply: { keyChange: string; executableChange: string };
    processNote: string;
    /** The worker's own media report; absent when the app has no STUDIX_WORKER_HEALTH_URL. */
    worker?: {
      reachable: boolean;
      report?: {
        executable: "configured" | "missing";
        state: string;
        code?: string;
        secretsKey: boolean;
        vendors: Record<string, boolean>;
      };
      mismatches: string[];
    };
  };
}

export interface PlatformMediaTest {
  ok: boolean;
  at: string;
  state: "ready" | "missing_executable" | "check_failed";
  diagnosis: "ok" | "missing_executable" | "missing_credential" | "check_failed";
  vendors: Array<{ vendor: string; keyName: string; hasKey: boolean }>;
  reason?: string;
  code?: string;
  paidCalls: false;
}

export interface FeatureSwitch {
  enabled: boolean;
  /** `operator`: forced on by env; `workspace`: the owner's switch here; `off`. */
  source: "operator" | "workspace" | "off";
  canChange: boolean;
}

/** Claude switches for the workspace; only a self-hosted server lets the owner change them. */
export interface WorkspaceFeatures {
  selfHosted: boolean;
  claudePlanner: FeatureSwitch;
  claudeSubscription: FeatureSwitch;
}

export interface ProviderConnectionList {
  storage: "available" | "unavailable";
  canAddWorkspaceKey: boolean;
  canAddPersonalKey: boolean;
  connections: ProviderConnection[];
}

/** A ChatGPT device-code sign-in in progress: the user enters `userCode` at `verificationUrl`. */
export interface ChatGptLoginStart {
  flowToken: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: string;
}

export type ChatGptLoginPoll =
  | { status: "pending"; intervalSeconds: number }
  | { status: "connected"; connection: ProviderConnection };

export interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Dollars per million tokens. */
  cost: { input: number; output: number };
}

export interface CatalogProvider {
  id: string;
  name: string;
  authMethods: Array<"api_key">;
  oauthRestriction?: string;
  models: CatalogModel[];
}

export interface ModelChoice {
  connectionId: string;
  provider: string;
  modelId: string;
}

export interface ModelPreference extends ModelChoice {
  id: string;
  scope: "workspace" | "user";
  stage: string;
  runtime: AgentRuntimeName;
  allowFallback: boolean;
  fallbacks: ModelChoice[];
  canManage: boolean;
  updatedAt: string;
}

export interface ModelPreferenceList {
  stages: string[];
  runtimes: AgentRuntimeName[];
  canEditWorkspace: boolean;
  canEditPersonal: boolean;
  preferences: ModelPreference[];
}

export interface ModelPreview {
  runtime: AgentRuntimeName;
  stage: string;
  selection?: {
    source: "user-stage" | "workspace-stage" | "user-default" | "workspace-default";
    preference: ModelPreference;
    usable: boolean;
    problem?: string;
  };
}

export interface SaveModelPreference {
  scope: "workspace" | "user";
  stage: string;
  connectionId: string;
  modelId: string;
  allowFallback?: boolean;
  fallbacks?: Array<{ connectionId: string; modelId: string }>;
}

export interface PlannerSelection {
  runtime: "claude";
  providerConnectionId: string;
}

export interface CreateVideoRequest {
  prompt: string;
  title?: string;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  durationMs?: number;
  language?: string;
  budgetCents?: number;
  idempotencyKey?: string;
  planner?: PlannerSelection;
  /** Runtime, paying connection, model and reasoning effort of the job's agent stages. */
  agent?: {
    runtime: AgentRuntimeName;
    providerConnectionId: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
  };
  /** A workflow pack id (GET /api/workflow-packs); defaults to brand-intro. */
  workflowTemplate?: string;
  renderPreset?: "preview" | "final";
}

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface WorkflowPackInfo {
  id: string;
  title: string;
}

export type ReviewStatus = "draft" | "in_review" | "approved" | "changes_requested";

export interface ReviewApproval {
  status: ReviewStatus;
  reviewer?: string;
  decidedAt?: string;
  note?: string;
}

/** Whether a finished render contains the shot's current content. Independent of approval. */
export type ShotRenderState = "rendered" | "outdated" | "not_rendered";

export interface ReviewShot {
  id: string;
  kind: string;
  description: string;
  script?: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  pointer: string;
  approval: ReviewApproval;
  render: ShotRenderState;
  revision?: number;
  changed: boolean;
  comments: number;
}

export interface ReviewScene {
  id: string;
  title: string;
  summary?: string;
  startMs: number;
  endMs: number;
  approval: ReviewApproval;
  revision?: number;
  changed: boolean;
  shots: ReviewShot[];
}

export interface ReviewVersion {
  id: string;
  version: number;
  source: string;
  parentVersionId?: string;
  description?: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  versionId?: string;
  author: { type: string; id: string };
  body: string;
  targetId?: string;
  atMs?: number;
  endMs?: number;
  createdAt: string;
}

export interface ProjectReview {
  project: Project & { workflowTemplate?: string };
  workflowTemplate?: string;
  currentVersion?: ReviewVersion;
  versions: ReviewVersion[];
  script: {
    prompt: string;
    lines: Array<{ sceneId: string; shotId: string; startMs: number; endMs: number; text: string }>;
  };
  timeline?: { durationMs: number; fps: number; aspectRatio: string; width: number; height: number };
  storyboard?: {
    revision: number;
    stored: boolean;
    title: string;
    approval: ReviewApproval;
    scenes: ReviewScene[];
    pendingShots: number;
  };
  renders: Array<RenderSummary & { versionId?: string; version?: number }>;
  cost: {
    spentCents: number;
    jobs: Array<{
      id: string;
      kind: string;
      status: string;
      createdAt: string;
      spentCents: number;
      budgetCents?: number;
    }>;
  };
  comments: ReviewComment[];
  invalidated: string[];
}

export interface StoryboardDecisionRequest {
  target: "storyboard" | "scene" | "shot";
  targetId?: string;
  decision: "approved" | "changes_requested";
  note?: string;
  expectedRevision?: number;
}

export interface FeedbackRequest {
  shotId?: string;
  sceneId?: string;
  assetId?: string;
  startMs?: number;
  endMs?: number;
  comment: string;
}

export type SkillScope = "workspace" | "platform";
export type SkillRiskLevel = "low" | "medium" | "high";

export type SkillSource =
  | { kind: "upload"; fileName: string | null }
  | { kind: "github"; owner: string; repo: string; path: string; ref: string | null; url: string };

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  status: "enabled" | "disabled";
  scope: SkillScope;
  activeVersionId: string | null;
  source: SkillSource;
  upstreamStatus: string;
  activeRiskLevel: SkillRiskLevel | null;
  manageable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRiskFinding {
  rule: string;
  severity: SkillRiskLevel;
  path: string;
  excerpt: string;
  line?: number;
}

export interface SkillVersionSummary {
  id: string;
  commitSha: string;
  contentHash: string;
  createdAt: string;
  active: boolean;
  riskLevel: SkillRiskLevel;
}

export interface SkillDetail {
  skill: Omit<SkillListItem, "activeRiskLevel">;
  version: SkillVersionSummary;
  risk: { level: SkillRiskLevel; findings: SkillRiskFinding[]; truncated?: boolean; scannedAt: string };
  content: { path: string; text?: string; binary?: true; bytes?: number; nextOffset?: number };
  files: Array<{
    path: string;
    kind: string;
    bytes: number;
    stored: boolean;
    binary?: boolean;
    executable?: boolean;
  }>;
  license: { status: string; declared?: string; notice: string };
  versions?: SkillVersionSummary[];
}

export interface SkillImportItem {
  path: string;
  outcome: string;
  name?: string;
  skillId?: string;
  versionId?: string;
  risk?: { level: SkillRiskLevel; findings: number };
  riskConfirmationRequired?: boolean;
  activationRequired?: boolean;
  error?: { code: string; message: string };
}

async function uploadZip<T>(path: string, file: Blob): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/zip" };
  const workspace = selectedWorkspace();
  if (workspace) headers[WORKSPACE_HEADER] = workspace;
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers, credentials: "same-origin", body: file });
  } catch {
    throw new ApiError(0, "NETWORK", "Cannot reach the Studix server. Check your connection and retry.");
  }
  const payload = (await res.json().catch(() => undefined)) as
    | { error?: { code?: string; message?: string; suggestedAction?: string } }
    | undefined;
  if (!res.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      res.status,
      error.code ?? `HTTP_${res.status}`,
      error.message ?? res.statusText,
      error.suggestedAction,
    );
  }
  return payload as T;
}

const enc = encodeURIComponent;

export type SsoProvider = "github" | "google";

export const SSO_LABELS: Record<SsoProvider, string> = { github: "GitHub", google: "Google" };

export interface LinkedAccount {
  providerId: string;
  accountId: string;
}

/**
 * Start an OAuth redirect (sign-in or linking). Better Auth returns the provider URL; success returns to
 * `returnTo`, and a failure to the same place with `?error=<code>` before the hash.
 */
async function redirectToProvider(path: string, provider: SsoProvider, returnTo: string): Promise<void> {
  const { url } = await request<{ url: string }>("POST", path, {
    provider,
    callbackURL: returnTo,
    errorCallbackURL: returnTo,
  });
  window.location.assign(url);
}

/** Display fields Better Auth exposes for a registered OAuth client. */
export interface OAuthClientInfo {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
}

/** An OAuth client (e.g. a Claude or ChatGPT connector) the signed-in user has authorized for a workspace. */
export interface OAuthConnection {
  id: string;
  clientId: string;
  clientName: string;
  clientUri?: string;
  scopes: string[];
  workspaceId: string;
  workspaceName: string;
  organizationName: string;
  createdAt: string;
}

/** Better Auth's answer to an OAuth step that continues the authorization flow elsewhere. */
export interface OAuthRedirect {
  redirect: boolean;
  url: string;
}

export const api = {
  skills: (scope: SkillScope | "visible" = "visible") =>
    request<{ items: SkillListItem[]; nextCursor?: string }>(
      "GET",
      `/api/skills?status=all&limit=100&scope=${scope}`,
    ),
  skill: (id: string, versionId?: string) =>
    request<SkillDetail>("GET", `/api/skills/${enc(id)}${versionId ? `?versionId=${enc(versionId)}` : ""}`),
  importSkills: (input: { repositoryUrl: string; ref?: string; path?: string; scope?: SkillScope }) =>
    request<{ results: SkillImportItem[] }>("POST", "/api/skills/import", input),
  uploadSkill: (
    file: File,
    options: { scope?: SkillScope; activate?: boolean; confirmHighRisk?: boolean },
  ) => {
    const query = new URLSearchParams({ fileName: file.name.slice(0, 200) });
    if (options.scope) query.set("scope", options.scope);
    if (options.activate) query.set("activate", "true");
    if (options.confirmHighRisk) query.set("confirmHighRisk", "true");
    return uploadZip<{ result: SkillImportItem }>(`/api/skills/upload?${query}`, file);
  },
  updateSkill: (
    id: string,
    input:
      | { action: "check" }
      | { action: "import"; activate?: boolean; confirmHighRisk?: boolean }
      | { action: "activate"; versionId: string; confirmHighRisk?: boolean }
      | { action: "enable"; confirmHighRisk?: boolean },
  ) => request<Record<string, unknown>>("POST", `/api/skills/${enc(id)}/update`, input),
  disableSkill: (id: string) => request("POST", `/api/skills/${enc(id)}/disable`, {}),
  deleteSkill: (id: string) => request("DELETE", `/api/skills/${enc(id)}`),
  signIn: (email: string, password: string) =>
    request("POST", "/api/auth/sign-in/email", { email, password }),
  signUp: (name: string, email: string, password: string) =>
    request("POST", "/api/auth/sign-up/email", { name, email, password }),
  signOut: () => request("POST", "/api/auth/sign-out", {}),
  ssoProviders: () => request<{ providers: SsoProvider[] }>("GET", "/api/sso-providers"),
  /** `returnTo` is where the provider sends the browser back (same-origin path, may carry a query). */
  signInWith: (provider: SsoProvider, returnTo = "/") =>
    redirectToProvider("/api/auth/sign-in/social", provider, returnTo),
  linkProvider: (provider: SsoProvider) =>
    redirectToProvider("/api/auth/link-social", provider, "/#/account"),
  linkedAccounts: () => request<LinkedAccount[]>("GET", "/api/auth/list-accounts"),
  me: () => request<Me>("GET", "/api/me"),
  oauthClient: (clientId: string) =>
    request<OAuthClientInfo>("GET", `/api/auth/oauth2/public-client?client_id=${enc(clientId)}`),
  selectOAuthWorkspace: (workspaceId: string) =>
    request<{ ok: true }>("POST", "/api/oauth/select-workspace", { workspaceId }),
  /** `oauthQuery` is the signed query string Better Auth put on the page URL, without the leading `?`. */
  continueOAuth: (oauthQuery: string) =>
    request<OAuthRedirect>("POST", "/api/auth/oauth2/continue", { postLogin: true, oauth_query: oauthQuery }),
  decideOAuthConsent: (accept: boolean, oauthQuery: string) =>
    request<OAuthRedirect>("POST", "/api/auth/oauth2/consent", { accept, oauth_query: oauthQuery }),
  oauthConnections: () => request<{ items: OAuthConnection[] }>("GET", "/api/oauth/connections"),
  revokeOAuthConnection: (id: string) => request<{ ok: true }>("DELETE", `/api/oauth/connections/${enc(id)}`),
  projects: () => request<Page<Project>>("GET", "/api/projects?limit=50"),
  project: (id: string) => request<ProjectDetail>("GET", `/api/projects/${enc(id)}`),
  projectReview: (id: string) => request<ProjectReview>("GET", `/api/projects/${enc(id)}/review`),
  decideStoryboard: (id: string, input: StoryboardDecisionRequest) =>
    request("POST", `/api/projects/${enc(id)}/storyboard/decision`, input),
  sendFeedback: (id: string, input: FeedbackRequest) =>
    request("POST", `/api/projects/${enc(id)}/feedback`, input),
  renderProject: (id: string, input: { versionId?: string; renderPreset?: "preview" | "final" }) =>
    request<{ job: Job }>("POST", `/api/projects/${enc(id)}/render`, input),
  createVideo: (input: CreateVideoRequest) =>
    request<{ project: Project; job: Job; replayed: boolean }>("POST", "/api/projects", input),
  /** `query` holds the `GET /api/jobs` sort/filter params (see JOB_LIST_PARAMS); `cursor` pages on. */
  jobs: (query: URLSearchParams = new URLSearchParams(), cursor?: string) => {
    const params = new URLSearchParams(query);
    params.set("limit", "50");
    if (cursor) params.set("cursor", cursor);
    return request<Page<Job>>("GET", `/api/jobs?${params}`);
  },
  job: (id: string) => request<{ job: Job; activity: ActivityEvent[] }>("GET", `/api/jobs/${enc(id)}`),
  cancelJob: (id: string) => request<Job>("POST", `/api/jobs/${enc(id)}/cancel`, {}),
  retryJob: (id: string) => request<Job>("POST", `/api/jobs/${enc(id)}/retry`, {}),
  /** `changes_requested` (creative gates) needs `targets` (asset ids to redo) and a `comment` saying how. */
  decideApproval: (
    id: string,
    decision: "approved" | "rejected" | "changes_requested",
    extra: { comment?: string; targets?: string[] } = {},
  ) => request("POST", `/api/approvals/${enc(id)}/decision`, { decision, ...extra }),
  apiKeys: () => request<{ items: ApiKey[] }>("GET", "/api/api-keys"),
  createApiKey: (input: { name: string; role?: string; expiresAt?: string }) =>
    request<{ apiKey: ApiKey; secret: string }>("POST", "/api/api-keys", input),
  revokeApiKey: (id: string) => request<ApiKey>("DELETE", `/api/api-keys/${enc(id)}`),
  connectors: () => request<{ items: Connector[] }>("GET", "/api/connectors"),
  addConnector: (input: { name: string; url: string }) =>
    request<Connector>("POST", "/api/connectors", input),
  testConnector: (id: string) =>
    request<{ ok: boolean; toolCount?: number; tools?: string[]; error?: string }>(
      "POST",
      `/api/connectors/${enc(id)}/test`,
      {},
    ),
  disableConnector: (id: string) => request<Connector>("POST", `/api/connectors/${enc(id)}/disable`, {}),
  anthropicProvider: () => request<AnthropicProvider>("GET", "/api/providers/anthropic"),
  platformSettings: () => request<PlatformSettings>("GET", "/api/platform/storage-media"),
  testPlatformStorage: () => request<PlatformStorageTest>("POST", "/api/platform/storage/test", {}),
  setPlatformStorageKey: (accessKeyId: string, secretAccessKey: string) =>
    request<PlatformStorageTest>("PUT", "/api/platform/storage/key", { accessKeyId, secretAccessKey }),
  revokePlatformStorageKey: () => request<void>("DELETE", "/api/platform/storage/key"),
  listStorageProfiles: (scope: StorageProfileScope = "platform") =>
    request<StorageProfile[]>("GET", profilesPath(scope)),
  createStorageProfile: (input: StorageProfileInput, scope: StorageProfileScope = "platform") =>
    request<StorageProfile>("POST", profilesPath(scope), input),
  updateStorageProfile: (id: string, input: StorageProfileInput, scope: StorageProfileScope = "platform") =>
    request<StorageProfile>("PUT", profilesPath(scope, id), input),
  activateStorageProfile: (id: string, scope: StorageProfileScope = "platform") =>
    request<StorageProfile>("POST", `${profilesPath(scope, id)}/activate`, {}),
  testStorageProfile: (id: string, scope: StorageProfileScope = "platform") =>
    request<PlatformStorageTest>("POST", `${profilesPath(scope, id)}/test`, {}),
  deleteStorageProfile: (id: string, scope: StorageProfileScope = "platform") =>
    request<void>("DELETE", profilesPath(scope, id)),
  testPlatformMediaKey: (name: string) =>
    request<PlatformMediaKeyTest>("POST", `/api/platform/media-keys/${enc(name)}/test`, {}),
  testPlatformMedia: () => request<PlatformMediaTest>("POST", "/api/platform/media/test", {}),
  setPlatformMediaKey: (name: string, value: string) =>
    request<PlatformCredential>("PUT", `/api/platform/media-keys/${enc(name)}`, { value }),
  revokePlatformMediaKey: (name: string) =>
    request<PlatformCredential>("DELETE", `/api/platform/media-keys/${enc(name)}`),
  workspaceMediaKeys: () => request<WorkspaceMediaKeys>("GET", "/api/providers/media-keys"),
  setWorkspaceMediaKey: (vendor: string, apiKey: string) =>
    request<WorkspaceMediaKey>("PUT", `/api/providers/media-keys/${enc(vendor)}`, { apiKey }),
  removeWorkspaceMediaKey: (vendor: string) =>
    request<WorkspaceMediaKey>("DELETE", `/api/providers/media-keys/${enc(vendor)}`),
  workspaceMultix: () => request<WorkspaceMultixSettings>("GET", "/api/providers/multix"),
  updateWorkspaceMultix: (values: WorkspaceMultixValues) =>
    request<WorkspaceMultixSettings>("PUT", "/api/providers/multix", values),
  resetWorkspaceMultix: () => request<WorkspaceMultixSettings>("DELETE", "/api/providers/multix"),
  checkWorkspaceMultix: () => request<WorkspaceMultixCheck>("POST", "/api/providers/multix/check", {}),
  multixCatalog: () => request<MultixCatalog>("GET", "/api/providers/multix/catalog"),
  workspaceFeatures: () => request<WorkspaceFeatures>("GET", "/api/providers/features"),
  updateWorkspaceFeatures: (patch: { claudePlanner?: boolean; claudeSubscription?: boolean }) =>
    request<WorkspaceFeatures>("PUT", "/api/providers/features", patch),
  connectClaudeSubscription: (input: { token: string; label?: string }) =>
    request<ProviderConnection>("POST", "/api/providers/anthropic/subscription", input),
  addAnthropicKey: (input: { owner: "workspace" | "user"; apiKey: string; label?: string }) =>
    request<ProviderConnection>("POST", "/api/providers/anthropic/api-keys", input),
  replaceAnthropicKey: (id: string, apiKey: string) =>
    request<ProviderConnection>("PUT", `/api/providers/anthropic/api-keys/${enc(id)}`, { apiKey }),
  testAnthropicKey: (id: string) =>
    request<ProviderConnection>("POST", `/api/providers/anthropic/api-keys/${enc(id)}/test`, {}),
  removeAnthropicKey: (id: string) =>
    request<ProviderConnection>("DELETE", `/api/providers/anthropic/api-keys/${enc(id)}`),
  workflowPacks: () => request<{ packs: WorkflowPackInfo[] }>("GET", "/api/workflow-packs"),
  providerCatalog: () => request<{ providers: CatalogProvider[] }>("GET", "/api/providers/catalog"),
  providerConnections: () => request<ProviderConnectionList>("GET", "/api/providers/connections"),
  addProviderKey: (input: {
    provider: string;
    owner: "workspace" | "user";
    apiKey: string;
    label?: string;
  }) => request<ProviderConnection>("POST", "/api/providers/connections", input),
  replaceProviderKey: (id: string, apiKey: string) =>
    request<ProviderConnection>("PUT", `/api/providers/connections/${enc(id)}`, { apiKey }),
  renameProviderConnection: (id: string, label: string) =>
    request<ProviderConnection>("PATCH", `/api/providers/connections/${enc(id)}`, { label }),
  startChatGptLogin: (owner: "workspace" | "user") =>
    request<ChatGptLoginStart>("POST", "/api/providers/connections/chatgpt/start", { owner }),
  pollChatGptLogin: (flowToken: string) =>
    request<ChatGptLoginPoll>("POST", "/api/providers/connections/chatgpt/poll", { flowToken }),
  setProviderRuntimes: (id: string, runtimes: AgentRuntimeName[]) =>
    request<ProviderConnection>("PUT", `/api/providers/connections/${enc(id)}/runtimes`, { runtimes }),
  testProviderKey: (id: string) =>
    request<ProviderConnection>("POST", `/api/providers/connections/${enc(id)}/test`, {}),
  removeProviderKey: (id: string) =>
    request<ProviderConnection>("DELETE", `/api/providers/connections/${enc(id)}`),
  modelPreferences: () => request<ModelPreferenceList>("GET", "/api/providers/models"),
  saveModelPreference: (input: SaveModelPreference) =>
    request<ModelPreference>("PUT", "/api/providers/models", input),
  removeModelPreference: (id: string) => request<void>("DELETE", `/api/providers/models/${enc(id)}`),
  modelPreview: (stage: string) =>
    request<ModelPreview>("GET", `/api/providers/models/preview?stage=${enc(stage)}`),
};
