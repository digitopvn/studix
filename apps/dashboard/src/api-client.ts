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
}

export interface Job {
  id: string;
  kind: string;
  status: string;
  projectId?: string;
  stage?: string;
  progress: number;
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

/** Claude subscription OAuth: informational only, Studix cannot connect it. */
export interface SubscriptionMethodInfo {
  authMethod: "oauth_subscription";
  title: string;
  billing: "subscription";
  availability: "restricted";
  reason: string;
  alternative: string;
  references: string[];
}

export interface ProviderConnectionTest {
  ok: boolean;
  at: string;
  latencyMs: number;
  httpStatus?: number;
  error?: StudixErrorPayload & { retryable: boolean };
}

export type AgentRuntimeName = "claude" | "pi";

/** A stored provider API key binding; the secret itself never leaves the server, only `keyHint`. */
export interface ProviderConnection {
  id: string;
  provider: string;
  authMethod: "api_key";
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

export interface ProviderConnectionList {
  storage: "available" | "unavailable";
  canAddWorkspaceKey: boolean;
  canAddPersonalKey: boolean;
  connections: ProviderConnection[];
}

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

const enc = encodeURIComponent;

export type SsoProvider = "github" | "google";

export const SSO_LABELS: Record<SsoProvider, string> = { github: "GitHub", google: "Google" };

export interface LinkedAccount {
  providerId: string;
  accountId: string;
}

/** Start an OAuth redirect (sign-in or linking). Better Auth returns the provider URL; errors come back as `/?error=`. */
async function redirectToProvider(path: string, provider: SsoProvider, callbackURL: string): Promise<void> {
  const { url } = await request<{ url: string }>("POST", path, {
    provider,
    callbackURL,
    errorCallbackURL: "/",
  });
  window.location.assign(url);
}

export const api = {
  signIn: (email: string, password: string) =>
    request("POST", "/api/auth/sign-in/email", { email, password }),
  signUp: (name: string, email: string, password: string) =>
    request("POST", "/api/auth/sign-up/email", { name, email, password }),
  signOut: () => request("POST", "/api/auth/sign-out", {}),
  ssoProviders: () => request<{ providers: SsoProvider[] }>("GET", "/api/sso-providers"),
  signInWith: (provider: SsoProvider) => redirectToProvider("/api/auth/sign-in/social", provider, "/"),
  linkProvider: (provider: SsoProvider) =>
    redirectToProvider("/api/auth/link-social", provider, "/#/account"),
  linkedAccounts: () => request<LinkedAccount[]>("GET", "/api/auth/list-accounts"),
  me: () => request<Me>("GET", "/api/me"),
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
  jobs: () => request<Page<Job>>("GET", "/api/jobs?limit=50"),
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
  addAnthropicKey: (input: { owner: "workspace" | "user"; apiKey: string; label?: string }) =>
    request<ProviderConnection>("POST", "/api/providers/anthropic/api-keys", input),
  replaceAnthropicKey: (id: string, apiKey: string) =>
    request<ProviderConnection>("PUT", `/api/providers/anthropic/api-keys/${enc(id)}`, { apiKey }),
  testAnthropicKey: (id: string) =>
    request<ProviderConnection>("POST", `/api/providers/anthropic/api-keys/${enc(id)}/test`, {}),
  removeAnthropicKey: (id: string) =>
    request<ProviderConnection>("DELETE", `/api/providers/anthropic/api-keys/${enc(id)}`),
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
