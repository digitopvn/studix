import {
  type ActorRef,
  AGENT_RUNTIMES,
  type AgentRuntimeName,
  type AuditRepository,
  actingUserId,
  actorRef,
  assertPermission,
  type BillingSource,
  can,
  type TenantContext,
} from "@studix/core";
import type {
  ProviderConnectionRecord,
  ProviderConnectionRepository,
  ProviderTestResultRecord,
} from "@studix/database";
import { type Logger, newId, StudixError, type StudixErrorPayload } from "@studix/shared";
import { z } from "zod";
import {
  ANTHROPIC_API_KEY_PATTERN,
  anthropicKeyHint,
  type ProviderKeyTester,
  type ProviderKeyTestResult,
} from "./anthropic-key-tester.ts";
import {
  CHATGPT_VERIFICATION_URL,
  type ChatGptAuthClient,
  type ChatGptTokens,
  chatGptEmail,
  codexAuthJson,
  tokensFromCodexAuthJson,
} from "./chatgpt-auth.ts";
import type { VendorKeyTester } from "./platform-vendor-key-tester.ts";
import type { SecretBox } from "./secret-box.ts";

/*
 * Outbound AI provider credentials. Two authentication methods are modelled and kept apart: an API key
 * billed by usage (Anthropic and the other providers the Pi runtime supports) and a Claude subscription
 * through OAuth. The subscription stays restricted unless the operator runs a self-hosted server and sets
 * STUDIX_CLAUDE_SUBSCRIPTION: then each user may store their own token from Claude Code's built-in
 * `claude setup-token`, personal only, released only to its owner's jobs and only to the Claude Code
 * binary (never to the Agent SDK, never used to call the API directly, never tested against it). Nothing here ever falls back from one method or connection to another, and Studix
 * inbound credentials (`stx_` keys, dashboard sessions) are never used as provider credentials.
 *
 * Each connection lists the agent runtimes allowed to spend it (ADR 0016). The Claude runtime only runs
 * Anthropic keys; a key enabled only for `claude` is never released to Pi until someone opts in.
 */

export type ConnectionOwner = "workspace" | "user";

export interface ProviderTestView {
  ok: boolean;
  at: Date;
  latencyMs: number;
  httpStatus?: number;
  error?: StudixErrorPayload;
}

/** Client-safe view: the key itself never leaves the service, only its hint. */
export interface ProviderConnectionView {
  id: string;
  /** Provider id from the Pi catalog, e.g. `anthropic`, `openai`, `openrouter`. */
  provider: string;
  authMethod: "api_key" | "oauth_subscription";
  billing: BillingSource;
  runtimes: AgentRuntimeName[];
  /** Bumped on every key rotation or runtime change. */
  version: number;
  owner: ConnectionOwner;
  ownedByMe: boolean;
  label: string;
  status: "available" | "invalid" | "unverified";
  keyHint?: string;
  lastTest?: ProviderTestView;
  canManage: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyMethodInfo {
  authMethod: "api_key";
  title: string;
  billing: "usage_based";
  availability: "available" | "unavailable";
  reason?: string;
  /** What the caller may add, so the dashboard offers only owners the server will accept. */
  canAddWorkspaceKey: boolean;
  canAddPersonalKey: boolean;
}

export interface SubscriptionMethodInfo {
  authMethod: "oauth_subscription";
  title: string;
  billing: "subscription";
  /** `restricted` unless the server is self-hosted with STUDIX_CLAUDE_SUBSCRIPTION on. */
  availability: "restricted" | "available" | "unavailable";
  reason: string;
  alternative: string;
  references: string[];
  /** The caller may connect their own subscription now. */
  canConnect: boolean;
}

export interface ProviderConnectionsOverview {
  provider: "anthropic";
  methods: [ApiKeyMethodInfo, SubscriptionMethodInfo];
  connections: ProviderConnectionView[];
}

/** Every connection, of every provider, the caller can see, plus what the caller may add. */
export interface ProviderConnectionList {
  storage: "available" | "unavailable";
  canAddWorkspaceKey: boolean;
  canAddPersonalKey: boolean;
  connections: ProviderConnectionView[];
}

export const ANTHROPIC_PROVIDER = "anthropic";
/** Provider of Codex connections: an OpenAI API key or a ChatGPT login. */
export const OPENAI_PROVIDER = "openai";

/** A ChatGPT login stored for the Codex runtime (the secret is the CLI's `auth.json`). */
export function isChatGptLogin(row: { provider: string; authMethod: string }): boolean {
  return row.provider === OPENAI_PROVIDER && row.authMethod === "oauth_subscription";
}

/** Runtimes that only run one provider's credentials. */
function runtimeProviderIssue(provider: string, runtimes: readonly AgentRuntimeName[]): string | undefined {
  if (provider !== ANTHROPIC_PROVIDER && runtimes.includes("claude"))
    return "the claude runtime only runs Anthropic keys";
  if (provider !== OPENAI_PROVIDER && runtimes.includes("codex"))
    return "the codex runtime only runs OpenAI credentials";
  return undefined;
}
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
/** Non-Anthropic keys have no common shape; this only rejects pasted junk (spaces, newlines, huge blobs). */
const GENERIC_API_KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;

const SUBSCRIPTION_TOKEN_PREFIX = /^sk-ant-oat/;
const ANTHROPIC_KEY_MESSAGE = "must be an Anthropic API key (sk-ant-…)";
const GENERIC_KEY_MESSAGE = "must be an API key without spaces";

function keyShapeOk(provider: string, apiKey: string): boolean {
  // A subscription token is never accepted as an API key: it would be tested against the API directly.
  if (SUBSCRIPTION_TOKEN_PREFIX.test(apiKey)) return false;
  return provider === ANTHROPIC_PROVIDER
    ? ANTHROPIC_API_KEY_PATTERN.test(apiKey)
    : GENERIC_API_KEY_PATTERN.test(apiKey);
}

const Runtimes = z
  .array(z.enum(AGENT_RUNTIMES))
  .min(1)
  .max(AGENT_RUNTIMES.length)
  .refine((list) => new Set(list).size === list.length, "must not repeat a runtime");

export const SaveApiKeyInput = z
  .object({
    provider: z
      .string()
      .trim()
      .regex(PROVIDER_ID_PATTERN, "must be a provider id")
      .default(ANTHROPIC_PROVIDER),
    owner: z.enum(["workspace", "user"]),
    apiKey: z.string().trim().min(1).max(512),
    label: z.string().trim().min(1).max(80).optional(),
    /** Default: `["claude"]` for Anthropic, `["pi"]` for every other provider. */
    runtimes: Runtimes.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const anthropic = input.provider === ANTHROPIC_PROVIDER;
    if (!keyShapeOk(input.provider, input.apiKey)) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: anthropic ? ANTHROPIC_KEY_MESSAGE : GENERIC_KEY_MESSAGE,
      });
    }
    const issue = input.runtimes ? runtimeProviderIssue(input.provider, input.runtimes) : undefined;
    if (issue) ctx.addIssue({ code: "custom", path: ["runtimes"], message: issue });
  });
export type SaveApiKeyInput = z.input<typeof SaveApiKeyInput>;

/** Token printed by `claude setup-token`; never an API key, which is billed by usage instead. */
const SUBSCRIPTION_TOKEN_PATTERN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,300}$/;
const SUBSCRIPTION_TOKEN_MESSAGE = "must be the token printed by `claude setup-token` (sk-ant-oat…)";

export const ConnectSubscriptionInput = z
  .object({
    token: z.string().trim().regex(SUBSCRIPTION_TOKEN_PATTERN, SUBSCRIPTION_TOKEN_MESSAGE),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type ConnectSubscriptionInput = z.input<typeof ConnectSubscriptionInput>;

export const RotateApiKeyInput = z.object({ apiKey: z.string().trim().min(1).max(512) }).strict();
export type RotateApiKeyInput = z.input<typeof RotateApiKeyInput>;

export const SetRuntimesInput = z.object({ runtimes: Runtimes }).strict();
export type SetRuntimesInput = z.input<typeof SetRuntimesInput>;

export const SetLabelInput = z.object({ label: z.string().trim().min(1).max(80) }).strict();
export type SetLabelInput = z.input<typeof SetLabelInput>;

export const StartChatGptLoginInput = z
  .object({ owner: z.enum(["workspace", "user"]).default("user") })
  .strict();
export type StartChatGptLoginInput = z.input<typeof StartChatGptLoginInput>;

export const PollChatGptLoginInput = z
  .object({
    flowToken: z.string().min(20).max(4000),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type PollChatGptLoginInput = z.input<typeof PollChatGptLoginInput>;

/** What the dashboard shows while the user signs in to ChatGPT; `flowToken` is opaque and sealed. */
export interface ChatGptLoginStart {
  flowToken: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: Date;
}

export type ChatGptLoginPoll =
  | { status: "pending"; intervalSeconds: number }
  | { status: "connected"; connection: ProviderConnectionView };

/** A device code is valid on OpenAI's side for about 15 minutes. */
const CHATGPT_LOGIN_TTL_MS = 15 * 60_000;
const FlowState = z.object({
  d: z.string(),
  u: z.string(),
  i: z.number(),
  o: z.enum(["workspace", "user"]),
  a: z.string(),
  exp: z.number(),
});

export interface ResolvedProviderCredential {
  /** An API key, or for `oauth_subscription` the owner's Claude Code token (Claude Code binary only). */
  apiKey: string;
  authMethod: "api_key" | "oauth_subscription";
  connection: ProviderConnectionView;
  /**
   * Called after a run got a 401 with this key. It re-tests the key directly and, only if Anthropic
   * still rejects it, marks the connection `invalid` so the API pre-check stops accepting it. A key
   * rotated in the meantime is left alone.
   */
  markRejected(): Promise<void>;
  /**
   * Stores a secret the runtime refreshed during the run (a ChatGPT login rotates its refresh token). A
   * no-op for anything else, or when the connection was replaced meanwhile.
   */
  storeRefreshed(secret: string): Promise<void>;
}

/** The Claude transport a resolved credential may go to: subscriptions only to the Claude Code binary. */
export function claudeCredentialKind(
  credential: Pick<ResolvedProviderCredential, "authMethod">,
): "api_key" | "subscription" {
  return credential.authMethod === "oauth_subscription" ? "subscription" : "api_key";
}

export interface ProviderConnectionService {
  /** The Anthropic view the Claude runtime settings use; every provider is listed by `list`. */
  overview(ctx: TenantContext): Promise<ProviderConnectionsOverview>;
  list(ctx: TenantContext): Promise<ProviderConnectionList>;
  saveApiKey(ctx: TenantContext, input: SaveApiKeyInput): Promise<ProviderConnectionView>;
  /** Store the caller's own Claude subscription token (self-hosted servers only, personal only). */
  connectSubscription(ctx: TenantContext, input: ConnectSubscriptionInput): Promise<ProviderConnectionView>;
  rotateApiKey(ctx: TenantContext, id: string, input: RotateApiKeyInput): Promise<ProviderConnectionView>;
  /** Opt a connection in or out of agent runtimes; managed by the same people who manage the key. */
  setRuntimes(ctx: TenantContext, id: string, input: SetRuntimesInput): Promise<ProviderConnectionView>;
  /** Rename a connection; the same people who manage the key may. The secret is never touched. */
  setLabel(ctx: TenantContext, id: string, input: SetLabelInput): Promise<ProviderConnectionView>;
  /** Start "Sign in with ChatGPT" for the Codex runtime (device code). */
  startChatGptLogin(ctx: TenantContext, input: StartChatGptLoginInput): Promise<ChatGptLoginStart>;
  /** Poll the sign-in once; stores the login as a connection when the user has entered the code. */
  pollChatGptLogin(ctx: TenantContext, input: PollChatGptLoginInput): Promise<ChatGptLoginPoll>;
  test(ctx: TenantContext, id: string): Promise<ProviderConnectionView>;
  remove(ctx: TenantContext, id: string): Promise<ProviderConnectionView>;
  /**
   * The plaintext key for one execution by `runtime`. `requestedBy` is whoever asked for the work (the
   * job's creator): a user-owned key is released only for its owner, and only to a runtime the
   * connection is enabled for. Never picks another connection.
   */
  resolveForExecution(
    ctx: TenantContext,
    input: { connectionId: string; requestedBy: ActorRef; runtime: AgentRuntimeName },
  ): Promise<ResolvedProviderCredential>;
  /**
   * Check, without decrypting anything, that the caller could run `runtime` with this connection. Used
   * when a job is created or a preference is saved so a bad selection fails fast; the worker checks
   * again with resolveForExecution.
   */
  assertUsable(
    ctx: TenantContext,
    connectionId: string,
    runtime: AgentRuntimeName,
  ): Promise<ProviderConnectionView>;
  /** The workspace's own media vendor keys (BYOK), one entry per vendor the server accepts. */
  listMediaKeys(ctx: TenantContext): Promise<WorkspaceMediaKeysOverview>;
  /** Store or replace the workspace's key for one media vendor (workspace admins only). */
  saveMediaKey(ctx: TenantContext, vendor: string, input: RotateApiKeyInput): Promise<WorkspaceMediaKeyView>;
  /** Remove the workspace's key; the vendor falls back to the platform key. */
  removeMediaKey(ctx: TenantContext, vendor: string): Promise<WorkspaceMediaKeyView>;
  /** Check the workspace's stored key with the vendor's free account lookup; nothing is paid. */
  testMediaKey(ctx: TenantContext, vendor: string): Promise<WorkspaceMediaKeyTestView>;
  /**
   * Plaintext media keys of the caller's workspace, by environment variable name, for the process that
   * runs its media calls. Never throws: an unreadable row is skipped and logged.
   */
  resolveMediaKeys(ctx: TenantContext): Promise<Readonly<Record<string, string>>>;
}

/** One media vendor as a workspace admin sees it; the key itself never leaves the service. */
export interface WorkspaceMediaKeyView {
  vendor: string;
  /** The vendor's display name, when the server knows it. */
  name?: string;
  /** The environment variable the media CLI reads the key from; a name, never a value. */
  keyName: string;
  /** The vendor has a free account lookup, so `testMediaKey` can say more than `unverified`. */
  testable: boolean;
  /** `workspace` when the workspace has its own key, else media calls use the platform key. */
  source: "workspace" | "platform";
  keyHint?: string;
  version?: number;
  updatedAt?: Date;
}

export interface WorkspaceMediaKeyTestView {
  vendor: string;
  at: Date;
  /** `unverified` when the vendor offers no free check or did not answer; no paid call is made. */
  verdict: "available" | "invalid" | "unverified";
  httpStatus?: number;
  note?: string;
}

export interface WorkspaceMediaKeysOverview {
  storage: "available" | "unavailable";
  canManage: boolean;
  keys: WorkspaceMediaKeyView[];
}

/** Provider id of a workspace media key row; agent runtimes never resolve these rows. */
export const MEDIA_PROVIDER_PREFIX = "media-";

export function isMediaProvider(provider: string): boolean {
  return provider.startsWith(MEDIA_PROVIDER_PREFIX);
}

export interface ProviderConnectionServiceDeps {
  connections: ProviderConnectionRepository;
  audit: AuditRepository;
  /** Called with the connection's provider; route non-Anthropic providers with `routeKeyTester`. */
  tester: ProviderKeyTester;
  /**
   * Providers that may be stored besides Anthropic (the Pi runtime's API-key providers). Without it only
   * Anthropic keys are accepted.
   */
  isSupportedProvider?: (provider: string) => boolean;
  /** Without it the API-key method is reported unavailable and nothing can be stored. */
  secrets?: SecretBox;
  /**
   * Whether users of this workspace may connect and run their own Claude subscription: STUDIX_CLAUDE_SUBSCRIPTION,
   * or the owner's switch on a self-hosted server (`WorkspaceFeatureService.effective`).
   */
  claudeSubscription?: boolean | ((ctx: TenantContext) => Promise<boolean>);
  /**
   * Media vendors a workspace may bring its own key for, vendor id to the environment variable the media
   * CLI reads (the Multix vendor keys). Without it no media key can be stored.
   */
  mediaKeyNames?: Readonly<Record<string, string>>;
  /** Display names of those vendors, by vendor id. */
  mediaKeyLabels?: Readonly<Record<string, string>>;
  /** The free account lookup of a media key, by environment variable name; without it keys stay unverified. */
  mediaKeyTester?: VendorKeyTester;
  /** The ChatGPT device-code client of the Codex runtime; without it ChatGPT sign-in is unavailable. */
  chatgpt?: ChatGptAuthClient;
  logger?: Logger;
}

export const SUBSCRIPTION_RESTRICTION: SubscriptionMethodInfo = {
  authMethod: "oauth_subscription",
  title: "Claude subscription (OAuth)",
  billing: "subscription",
  availability: "restricted",
  reason:
    "Not available for Studix cloud. Anthropic does not allow third-party services to offer Claude.ai login or use Free, Pro or Max plan credentials on behalf of their users without approval, and Studix has none.",
  alternative:
    "Use an Anthropic API key (usage-based billing), or run Claude Code on your own machine and connect it to Studix as an MCP client.",
  references: [
    "https://code.claude.com/docs/en/legal-and-compliance",
    "https://code.claude.com/docs/en/agent-sdk/overview",
  ],
  canConnect: false,
};

const STORAGE_OFF =
  "Encrypted credential storage is not configured on this server. The operator must set STUDIX_SECRETS_KEY.";

const SUBSCRIPTION_REFERENCES = ["https://code.claude.com/docs/en/legal-and-compliance"];

/** What the subscription card offers on this server and to this caller. */
function subscriptionMethod(ctx: TenantContext, enabled: boolean, storage: boolean): SubscriptionMethodInfo {
  if (!enabled) return SUBSCRIPTION_RESTRICTION;
  const alternative = "You can also add your own Anthropic API key (usage-based billing) instead.";
  if (!storage) {
    return {
      ...SUBSCRIPTION_RESTRICTION,
      availability: "unavailable",
      reason: STORAGE_OFF,
      alternative,
      references: SUBSCRIPTION_REFERENCES,
    };
  }
  return {
    ...SUBSCRIPTION_RESTRICTION,
    availability: "available",
    reason:
      "Self-hosted server: connect your own Claude subscription. Sign in with Claude Code's own `claude setup-token` on your machine and paste the token. It is stored encrypted for you only, and only the official Claude Code binary uses it, for jobs you create.",
    alternative,
    references: SUBSCRIPTION_REFERENCES,
    canConnect: canAddPersonal(ctx),
  };
}

const SUBJECT = "provider_connection";

function associatedData(ctx: TenantContext, id: string): string {
  return `${ctx.organizationId}/${ctx.workspaceId}/${SUBJECT}/${id}`;
}

/** The signed-in user. Only they add, connect or change their personal keys; delegated clients do not. */
function userId(ctx: TenantContext): string | undefined {
  return ctx.actor.type === "user" ? ctx.actor.id : undefined;
}

/** A personal key is its owner's to see and run, also through an OAuth client acting for them. */
function isMine(ctx: TenantContext, row: ProviderConnectionRecord): boolean {
  return ownedBy(row, ctx.actor);
}

/** True when `actor` is, or acts for, the owner of a personal key. API keys and system actors never are. */
function ownedBy(row: ProviderConnectionRecord, actor: ActorRef): boolean {
  const user = actingUserId(actor);
  return row.ownerType === "user" && user !== undefined && row.ownerUserId === user;
}

/** Workspace keys are managed by admins; a personal key by its signed-in owner (admins may still remove it). */
function canManage(ctx: TenantContext, row: ProviderConnectionRecord): boolean {
  return row.ownerType === "workspace"
    ? can(ctx.actor, "member:manage")
    : userId(ctx) !== undefined && isMine(ctx, row);
}

function canSee(ctx: TenantContext, row: ProviderConnectionRecord): boolean {
  return row.ownerType === "workspace" || isMine(ctx, row) || can(ctx.actor, "member:manage");
}

function toTestRecord(result: ProviderKeyTestResult): ProviderTestResultRecord {
  const { verdict: _verdict, ...rest } = result;
  return rest;
}

function toView(ctx: TenantContext, row: ProviderConnectionRecord): ProviderConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    authMethod: row.authMethod,
    billing: row.billingSource,
    runtimes: row.runtimes,
    version: row.version,
    owner: row.ownerType,
    ownedByMe: isMine(ctx, row),
    label: row.label,
    status: row.status === "revoked" ? "invalid" : row.status,
    keyHint: row.secretHint,
    lastTest: row.lastTest,
    canManage: canManage(ctx, row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  // Issues carry paths and messages only, never the submitted value.
  throw new StudixError("VALIDATION", "Invalid provider credential request", {
    details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
  });
}

export function providerName(provider: string): string {
  return provider === ANTHROPIC_PROVIDER ? "Anthropic" : provider;
}

/** `sk-ant-…a1b2` for Anthropic, `…a1b2` otherwise: enough to tell keys apart, never enough to use one. */
function subscriptionHint(token: string): string {
  return `sk-ant-oat…${token.slice(-4)}`;
}

export function apiKeyHint(provider: string, apiKey: string): string {
  return provider === ANTHROPIC_PROVIDER ? anthropicKeyHint(apiKey) : `…${apiKey.slice(-4)}`;
}

/**
 * A key the provider refuses is bad input, not a Studix auth failure: answering 401/403 would read as
 * "your Studix session expired" or "Studix denied you". The upstream verdict stays in details.
 */
function rejected(provider: string, result: ProviderKeyTestResult): StudixError {
  const error = result.error;
  return new StudixError("VALIDATION", error?.message ?? `${providerName(provider)} rejected the API key`, {
    retryable: false,
    suggestedAction: error?.suggestedAction ?? "Check the key with the provider, then paste it again.",
    details: { httpStatus: result.httpStatus, providerCode: error?.code },
  });
}

/** A rotated key must keep the connection's provider shape. */
function assertKeyShape(provider: string, apiKey: string): void {
  if (keyShapeOk(provider, apiKey)) return;
  throw new StudixError("VALIDATION", "Invalid provider credential request", {
    details: {
      issues: [
        {
          path: "apiKey",
          message: provider === ANTHROPIC_PROVIDER ? ANTHROPIC_KEY_MESSAGE : GENERIC_KEY_MESSAGE,
        },
      ],
    },
  });
}

function defaultRuntimes(provider: string): AgentRuntimeName[] {
  return provider === ANTHROPIC_PROVIDER ? ["claude"] : ["pi"];
}

/**
 * Send each provider's key to its own tester: Anthropic keeps the free `/v1/models` check, other
 * providers use `others` (the Pi probe). Without `others`, non-Anthropic keys are stored `unverified`.
 */
export function routeKeyTester(anthropic: ProviderKeyTester, others?: ProviderKeyTester): ProviderKeyTester {
  return {
    test(apiKey, provider) {
      if (provider === ANTHROPIC_PROVIDER) return anthropic.test(apiKey, provider);
      if (others) return others.test(apiKey, provider);
      return Promise.resolve({
        ok: false,
        at: new Date(),
        latencyMs: 0,
        verdict: "unverified",
        error: {
          code: "UNAVAILABLE",
          message: `This server cannot test ${providerName(provider)} keys`,
          retryable: false,
        },
      });
    },
  };
}

function canAddPersonal(ctx: TenantContext): boolean {
  return userId(ctx) !== undefined && can(ctx.actor, "project:write");
}

export function createProviderConnectionService(
  deps: ProviderConnectionServiceDeps,
): ProviderConnectionService {
  const requireSecrets = (): SecretBox => {
    if (!deps.secrets) {
      throw new StudixError("UNAVAILABLE", "Encrypted credential storage is not configured on this server", {
        retryable: false,
        suggestedAction: "Ask the operator to set STUDIX_SECRETS_KEY.",
      });
    }
    return deps.secrets;
  };

  /** A stored key that no longer decrypts (lost or rotated-out master key) is not a server bug for the user. */
  const openKey = (ctx: TenantContext, row: ProviderConnectionRecord, ciphertext: string): string => {
    try {
      return requireSecrets().open(ciphertext, associatedData(ctx, row.id));
    } catch (err) {
      if (err instanceof StudixError && err.code === "UNAVAILABLE") throw err;
      deps.logger?.error("provider credential could not be decrypted", {
        connectionId: row.id,
        workspaceId: ctx.workspaceId,
      });
      throw new StudixError(
        "UNAVAILABLE",
        `The stored ${providerName(row.provider)} key can no longer be decrypted`,
        {
          retryable: false,
          suggestedAction: "Replace the key in Settings → AI & Providers.",
        },
      );
    }
  };

  const mediaKeyNames = deps.mediaKeyNames ?? {};
  const mediaKeyLabels = deps.mediaKeyLabels ?? {};

  const mediaKeyView = (vendor: string, row: ProviderConnectionRecord | undefined): WorkspaceMediaKeyView => {
    const keyName = mediaKeyNames[vendor] as string;
    return {
      ...mediaView(vendor, row),
      ...(mediaKeyLabels[vendor] ? { name: mediaKeyLabels[vendor] } : {}),
      keyName,
      testable: deps.mediaKeyTester?.supports?.(keyName) ?? false,
    };
  };

  const requireMediaVendor = (vendor: string) => {
    if (!Object.hasOwn(mediaKeyNames, vendor)) {
      throw new StudixError("VALIDATION", `Media vendor ${vendor} is not supported`, {
        retryable: false,
        details: { supported: Object.keys(mediaKeyNames) },
      });
    }
  };

  /** The caller's workspace media key rows with a key, by vendor; the repository scopes by workspace. */
  const mediaRows = async (ctx: TenantContext): Promise<Map<string, ProviderConnectionRecord>> => {
    const rows = new Map<string, ProviderConnectionRecord>();
    for (const row of await deps.connections.listActive(ctx)) {
      if (!isMediaProvider(row.provider) || row.ownerType !== "workspace" || !row.secretCiphertext) continue;
      const vendor = row.provider.slice(MEDIA_PROVIDER_PREFIX.length);
      if (Object.hasOwn(mediaKeyNames, vendor)) rows.set(vendor, row);
    }
    return rows;
  };

  const load = async (ctx: TenantContext, id: string): Promise<ProviderConnectionRecord> => {
    const row = await deps.connections.get(ctx, id);
    // Media keys have their own calls: the generic ones could enable them for an agent runtime.
    if (!row || row.revokedAt || isMediaProvider(row.provider) || !canSee(ctx, row)) {
      throw new StudixError("NOT_FOUND", `provider connection ${id} not found`);
    }
    return row;
  };

  const requireManage = (ctx: TenantContext, row: ProviderConnectionRecord) => {
    if (!canManage(ctx, row)) {
      throw new StudixError("FORBIDDEN", "You cannot change this provider connection", {
        suggestedAction:
          row.ownerType === "workspace"
            ? "Ask a workspace admin to change workspace keys."
            : "Only the owner can change a personal key.",
      });
    }
  };

  const subscriptionOn = async (ctx: TenantContext): Promise<boolean> =>
    typeof deps.claudeSubscription === "function"
      ? deps.claudeSubscription(ctx)
      : deps.claudeSubscription === true;

  const audit = (ctx: TenantContext, action: string, row: ProviderConnectionRecord) =>
    deps.audit.append(ctx, {
      actor: actorRef(ctx.actor),
      action: `${SUBJECT}.${action}`,
      subjectType: SUBJECT,
      subjectId: row.id,
      data: {
        provider: row.provider,
        authMethod: row.authMethod,
        owner: row.ownerType,
        status: row.status,
        keyHint: row.secretHint,
        runtimes: row.runtimes,
        version: row.version,
      },
    });

  /** The rules both resolveForExecution and assertUsable enforce; no fallback to any other row. */
  async function usableRow(
    ctx: TenantContext,
    connectionId: string,
    requestedBy: ActorRef,
    runtime: AgentRuntimeName,
  ): Promise<ProviderConnectionRecord> {
    assertPermission(ctx, "project:write");
    const row = await deps.connections.get(ctx, connectionId);
    const chatgpt = row !== undefined && isChatGptLogin(row);
    const subscription = row?.authMethod === "oauth_subscription" && !chatgpt;
    if (
      !row ||
      row.revokedAt ||
      !row.secretCiphertext ||
      isMediaProvider(row.provider) ||
      (row.authMethod !== "api_key" && !chatgpt && !(subscription && (await subscriptionOn(ctx))))
    ) {
      throw new StudixError("UNAVAILABLE", "The selected provider connection no longer exists", {
        retryable: false,
        suggestedAction: "Choose another provider connection in Settings → AI & Providers.",
      });
    }
    const name = providerName(row.provider);
    if (subscription && (row.ownerType !== "user" || runtime !== "claude")) {
      throw new StudixError("FORBIDDEN", "A Claude subscription only runs its owner's Claude Code jobs", {
        retryable: false,
      });
    }
    // The owner's own jobs, including those an OAuth client created for them; never an API key's.
    if (row.ownerType === "user" && !ownedBy(row, requestedBy)) {
      throw new StudixError("FORBIDDEN", `A personal ${name} key can only be used by its owner`, {
        retryable: false,
        suggestedAction: "Use a workspace key or your own personal key.",
      });
    }
    if (chatgpt && runtime !== "codex") {
      throw new StudixError("FORBIDDEN", "A ChatGPT login only runs the codex runtime", { retryable: false });
    }
    if (!row.runtimes.includes(runtime) || runtimeProviderIssue(row.provider, [runtime])) {
      throw new StudixError("FORBIDDEN", `This ${name} key is not enabled for the ${runtime} runtime`, {
        retryable: false,
        suggestedAction: `Enable the ${runtime} runtime for this key in Settings → AI & Providers, or choose another key.`,
      });
    }
    if (row.status === "invalid") {
      throw new StudixError("UNAUTHENTICATED", `The ${name} API key was rejected at its last test`, {
        retryable: false,
        suggestedAction: "Replace the key in Settings → AI & Providers, then retry.",
      });
    }
    return row;
  }

  /** Subscription rows are shown (and usable) only while the feature stays on for the workspace. */
  const visible = (row: ProviderConnectionRecord, subscriptions: boolean) =>
    row.authMethod === "api_key" ||
    isChatGptLogin(row) ||
    (row.authMethod === "oauth_subscription" && subscriptions);

  const chatGptHint = (tokens: ChatGptTokens) =>
    `ChatGPT …${(tokens.accountId ?? tokens.refreshToken).slice(-4)}`;

  const flowAad = (ctx: TenantContext) => `${ctx.organizationId}/${ctx.workspaceId}/chatgpt-login`;

  /** Re-seals a ChatGPT login after a refresh, unless the secret was replaced meanwhile. */
  async function storeChatGptTokens(
    ctx: TenantContext,
    row: ProviderConnectionRecord,
    previousCiphertext: string,
    tokens: ChatGptTokens,
  ): Promise<ProviderConnectionRecord | undefined> {
    const updated = await deps.connections.recordTest(ctx, row.id, previousCiphertext, {
      status: "available",
      lastTest: { ok: true, at: new Date(), latencyMs: 0 },
      secretCiphertext: requireSecrets().seal(codexAuthJson(tokens), associatedData(ctx, row.id)),
      secretHint: chatGptHint(tokens),
    });
    return updated;
  }

  return {
    async overview(ctx) {
      assertPermission(ctx, "workspace:read");
      const rows = await deps.connections.listActive(ctx);
      const subscriptions = await subscriptionOn(ctx);
      return {
        provider: "anthropic",
        methods: [
          {
            authMethod: "api_key",
            title: "Anthropic API key (usage-based)",
            billing: "usage_based",
            availability: deps.secrets ? "available" : "unavailable",
            canAddWorkspaceKey: Boolean(deps.secrets) && can(ctx.actor, "member:manage"),
            canAddPersonalKey: Boolean(deps.secrets) && canAddPersonal(ctx),
            ...(deps.secrets ? {} : { reason: STORAGE_OFF }),
          },
          subscriptionMethod(ctx, subscriptions, Boolean(deps.secrets)),
        ],
        connections: rows
          .filter(
            (row) => row.provider === ANTHROPIC_PROVIDER && visible(row, subscriptions) && canSee(ctx, row),
          )
          .map((row) => toView(ctx, row)),
      };
    },

    async list(ctx) {
      assertPermission(ctx, "workspace:read");
      const rows = await deps.connections.listActive(ctx);
      const subscriptions = await subscriptionOn(ctx);
      return {
        storage: deps.secrets ? "available" : "unavailable",
        canAddWorkspaceKey: Boolean(deps.secrets) && can(ctx.actor, "member:manage"),
        canAddPersonalKey: Boolean(deps.secrets) && canAddPersonal(ctx),
        connections: rows
          .filter((row) => !isMediaProvider(row.provider) && visible(row, subscriptions) && canSee(ctx, row))
          .map((row) => toView(ctx, row)),
      };
    },

    async saveApiKey(ctx, rawInput) {
      const input = parse(SaveApiKeyInput, rawInput);
      if (input.owner === "workspace") assertPermission(ctx, "member:manage");
      else {
        assertPermission(ctx, "project:write");
        if (!userId(ctx)) {
          throw new StudixError("FORBIDDEN", "Personal keys can only be added by a signed-in user");
        }
      }
      if (input.provider !== ANTHROPIC_PROVIDER && !deps.isSupportedProvider?.(input.provider)) {
        throw new StudixError("VALIDATION", `Provider ${input.provider} is not supported`, {
          retryable: false,
          suggestedAction: "Choose a provider from the catalog in Settings → AI & Providers.",
        });
      }
      const secrets = requireSecrets();
      // Fail before calling the provider: the unique index still settles a concurrent race.
      const ownerUserId = input.owner === "user" ? userId(ctx) : undefined;
      const active = await deps.connections.listActive(ctx);
      if (
        active.some(
          (row) =>
            row.provider === input.provider &&
            row.authMethod === "api_key" &&
            row.ownerType === input.owner &&
            row.ownerUserId === ownerUserId,
        )
      ) {
        throw new StudixError("CONFLICT", "An active connection already exists for this owner", {
          retryable: false,
          suggestedAction: "Replace the existing key instead of adding another one.",
        });
      }
      const result = await deps.tester.test(input.apiKey, input.provider);
      if (result.verdict === "invalid") throw rejected(input.provider, result);
      const id = newId("pcon");
      const row = await deps.connections.create(ctx, {
        id,
        provider: input.provider,
        authMethod: "api_key",
        ownerType: input.owner,
        ownerUserId,
        label: input.label ?? (input.owner === "workspace" ? "Workspace key" : "Personal key"),
        status: result.verdict,
        secretCiphertext: secrets.seal(input.apiKey, associatedData(ctx, id)),
        secretHint: apiKeyHint(input.provider, input.apiKey),
        lastTest: toTestRecord(result),
        runtimes: input.runtimes ?? defaultRuntimes(input.provider),
        // Only API keys are stored, and an API key is always billed by usage.
        billingSource: "usage_based",
        createdBy: actorRef(ctx.actor),
      });
      await audit(ctx, "created", row);
      deps.logger?.info("provider connection created", { connectionId: id, workspaceId: ctx.workspaceId });
      return toView(ctx, row);
    },

    async connectSubscription(ctx, rawInput) {
      if (!(await subscriptionOn(ctx))) {
        throw new StudixError("FORBIDDEN", "Claude subscriptions are not available on this server", {
          retryable: false,
          suggestedAction: SUBSCRIPTION_RESTRICTION.alternative,
        });
      }
      assertPermission(ctx, "project:write");
      const ownerUserId = userId(ctx);
      if (!ownerUserId) {
        throw new StudixError("FORBIDDEN", "A Claude subscription can only be connected by a signed-in user");
      }
      const input = parse(ConnectSubscriptionInput, rawInput);
      const secrets = requireSecrets();
      const active = await deps.connections.listActive(ctx);
      if (
        active.some(
          (row) =>
            row.provider === ANTHROPIC_PROVIDER &&
            row.authMethod === "oauth_subscription" &&
            row.ownerUserId === ownerUserId,
        )
      ) {
        throw new StudixError("CONFLICT", "Your Claude subscription is already connected", {
          retryable: false,
          suggestedAction: "Replace the token instead of connecting again.",
        });
      }
      const id = newId("pcon");
      // Not tested here: only the Claude Code binary may use the token, so the first run verifies it.
      const row = await deps.connections.create(ctx, {
        id,
        provider: ANTHROPIC_PROVIDER,
        authMethod: "oauth_subscription",
        ownerType: "user",
        ownerUserId,
        label: input.label ?? "My Claude subscription",
        status: "unverified",
        secretCiphertext: secrets.seal(input.token, associatedData(ctx, id)),
        secretHint: subscriptionHint(input.token),
        runtimes: ["claude"],
        billingSource: "subscription",
        createdBy: actorRef(ctx.actor),
      });
      await audit(ctx, "created", row);
      deps.logger?.info("claude subscription connected", { connectionId: id, workspaceId: ctx.workspaceId });
      return toView(ctx, row);
    },

    async rotateApiKey(ctx, id, rawInput) {
      const existing = await load(ctx, id);
      requireManage(ctx, existing);
      if (existing.authMethod === "oauth_subscription") {
        const token = parse(ConnectSubscriptionInput, {
          token: (rawInput as { apiKey?: unknown })?.apiKey,
        }).token;
        const row = await deps.connections.update(ctx, id, {
          status: "unverified",
          secretCiphertext: requireSecrets().seal(token, associatedData(ctx, id)),
          secretHint: subscriptionHint(token),
        });
        await audit(ctx, "rotated", row);
        return toView(ctx, row);
      }
      const input = parse(RotateApiKeyInput, rawInput);
      assertKeyShape(existing.provider, input.apiKey);
      const secrets = requireSecrets();
      const result = await deps.tester.test(input.apiKey, existing.provider);
      if (result.verdict === "invalid") throw rejected(existing.provider, result);
      const row = await deps.connections.update(ctx, id, {
        status: result.verdict,
        secretCiphertext: secrets.seal(input.apiKey, associatedData(ctx, id)),
        secretHint: apiKeyHint(existing.provider, input.apiKey),
        lastTest: toTestRecord(result),
      });
      await audit(ctx, "rotated", row);
      return toView(ctx, row);
    },

    async setRuntimes(ctx, id, rawInput) {
      const input = parse(SetRuntimesInput, rawInput);
      const existing = await load(ctx, id);
      requireManage(ctx, existing);
      if (existing.authMethod === "oauth_subscription" && input.runtimes.some((r) => r !== "claude")) {
        throw new StudixError("VALIDATION", "A Claude subscription only runs on the claude runtime", {
          retryable: false,
        });
      }
      const issue = runtimeProviderIssue(existing.provider, input.runtimes);
      if (issue) {
        throw new StudixError("VALIDATION", `${issue[0]?.toUpperCase()}${issue.slice(1)}`, {
          retryable: false,
        });
      }
      const row = await deps.connections.update(ctx, id, { runtimes: [...input.runtimes].sort() });
      await audit(ctx, "runtimes_changed", row);
      return toView(ctx, row);
    },

    async setLabel(ctx, id, rawInput) {
      const input = parse(SetLabelInput, rawInput);
      const existing = await load(ctx, id);
      requireManage(ctx, existing);
      if (existing.label === input.label) return toView(ctx, existing);
      const row = await deps.connections.update(ctx, id, { label: input.label });
      await deps.audit.append(ctx, {
        actor: actorRef(ctx.actor),
        action: `${SUBJECT}.renamed`,
        subjectType: SUBJECT,
        subjectId: row.id,
        data: { provider: row.provider, owner: row.ownerType, from: existing.label, to: row.label },
      });
      return toView(ctx, row);
    },

    async startChatGptLogin(ctx, rawInput) {
      const input = parse(StartChatGptLoginInput, rawInput);
      if (input.owner === "workspace") assertPermission(ctx, "member:manage");
      else assertPermission(ctx, "project:write");
      const actorId = userId(ctx);
      if (!actorId) throw new StudixError("FORBIDDEN", "ChatGPT can only be connected by a signed-in user");
      const client = deps.chatgpt;
      if (!client) {
        throw new StudixError("UNAVAILABLE", "ChatGPT sign-in is not configured on this server", {
          retryable: false,
          suggestedAction: "Add an OpenAI API key for the codex runtime instead.",
        });
      }
      const secrets = requireSecrets();
      const code = await client.requestDeviceCode();
      const expiresAt = new Date(Date.now() + CHATGPT_LOGIN_TTL_MS);
      // Stateless: the device id travels sealed to this workspace and caller, so any app instance can poll.
      const state: z.infer<typeof FlowState> = {
        d: code.deviceAuthId,
        u: code.userCode,
        i: code.intervalSeconds,
        o: input.owner,
        a: actorId,
        exp: expiresAt.getTime(),
      };
      return {
        flowToken: secrets.seal(JSON.stringify(state), flowAad(ctx)),
        userCode: code.userCode,
        verificationUrl: CHATGPT_VERIFICATION_URL,
        intervalSeconds: code.intervalSeconds,
        expiresAt,
      };
    },

    async pollChatGptLogin(ctx, rawInput) {
      const input = parse(PollChatGptLoginInput, rawInput);
      const client = deps.chatgpt;
      if (!client) throw new StudixError("UNAVAILABLE", "ChatGPT sign-in is not configured on this server");
      const secrets = requireSecrets();
      let state: z.infer<typeof FlowState>;
      try {
        state = FlowState.parse(JSON.parse(secrets.open(input.flowToken, flowAad(ctx))));
      } catch {
        throw new StudixError("VALIDATION", "This ChatGPT sign-in is not valid here", {
          retryable: false,
          suggestedAction: "Start the ChatGPT sign-in again.",
        });
      }
      if (state.a !== userId(ctx)) {
        throw new StudixError("FORBIDDEN", "This ChatGPT sign-in was started by someone else");
      }
      if (state.o === "workspace") assertPermission(ctx, "member:manage");
      if (Date.now() > state.exp) {
        throw new StudixError("VALIDATION", "The ChatGPT sign-in code expired", {
          retryable: false,
          suggestedAction: "Start the ChatGPT sign-in again.",
        });
      }
      const result = await client.poll({ deviceAuthId: state.d, userCode: state.u });
      if (result.status === "pending") return { status: "pending", intervalSeconds: state.i };
      const ownerUserId = state.o === "user" ? state.a : undefined;
      const active = await deps.connections.listActive(ctx);
      const existing = active.find(
        (row) => isChatGptLogin(row) && row.ownerType === state.o && row.ownerUserId === ownerUserId,
      );
      const secret = codexAuthJson(result.tokens);
      if (existing) {
        // Signing in again replaces the stored login (for example another ChatGPT account).
        const row = await deps.connections.update(ctx, existing.id, {
          status: "available",
          secretCiphertext: secrets.seal(secret, associatedData(ctx, existing.id)),
          secretHint: chatGptHint(result.tokens),
          lastTest: { ok: true, at: new Date(), latencyMs: 0 },
        });
        await audit(ctx, "rotated", row);
        return { status: "connected", connection: toView(ctx, row) };
      }
      const id = newId("pcon");
      const email = chatGptEmail(result.tokens.idToken);
      const row = await deps.connections.create(ctx, {
        id,
        provider: OPENAI_PROVIDER,
        authMethod: "oauth_subscription",
        ownerType: state.o,
        ownerUserId,
        label: input.label ?? (email ? `ChatGPT (${email})` : "ChatGPT"),
        status: "available",
        secretCiphertext: secrets.seal(secret, associatedData(ctx, id)),
        secretHint: chatGptHint(result.tokens),
        lastTest: { ok: true, at: new Date(), latencyMs: 0 },
        runtimes: ["codex"],
        billingSource: "subscription",
        createdBy: actorRef(ctx.actor),
      });
      await audit(ctx, "created", row);
      deps.logger?.info("chatgpt login connected", { connectionId: id, workspaceId: ctx.workspaceId });
      return { status: "connected", connection: toView(ctx, row) };
    },

    async test(ctx, id) {
      const existing = await load(ctx, id);
      requireManage(ctx, existing);
      if (!existing.secretCiphertext)
        throw new StudixError("NOT_FOUND", `provider connection ${id} has no key`);
      if (isChatGptLogin(existing)) {
        // The test is a token refresh, which also rotates the refresh token, so it is stored right away.
        const stored = tokensFromCodexAuthJson(openKey(ctx, existing, existing.secretCiphertext));
        const started = Date.now();
        try {
          if (!stored || !deps.chatgpt)
            throw new StudixError("UNAVAILABLE", "ChatGPT sign-in is not configured");
          const fresh = await deps.chatgpt.refresh(stored.refreshToken);
          const row = await storeChatGptTokens(ctx, existing, existing.secretCiphertext, fresh);
          if (!row) return toView(ctx, await load(ctx, id));
          await audit(ctx, "tested", row);
          return toView(ctx, row);
        } catch (err) {
          const error = err instanceof StudixError ? err : new StudixError("PROVIDER_ERROR", String(err));
          const row = await deps.connections.recordTest(ctx, id, existing.secretCiphertext, {
            // Only OpenAI refusing the refresh token means the login is gone; anything else is a hiccup.
            status: error.code === "VALIDATION" ? "invalid" : existing.status,
            lastTest: { ok: false, at: new Date(), latencyMs: Date.now() - started, error: error.toJSON() },
          });
          return toView(ctx, row ?? (await load(ctx, id)));
        }
      }
      // Never sent to the API directly; the next Claude Code run is the test.
      if (existing.authMethod === "oauth_subscription") return toView(ctx, existing);
      const apiKey = openKey(ctx, existing, existing.secretCiphertext);
      const result = await deps.tester.test(apiKey, existing.provider);
      const row = await deps.connections.recordTest(ctx, id, existing.secretCiphertext, {
        status: result.verdict,
        lastTest: toTestRecord(result),
      });
      // The key was replaced while it was being tested: report the current key, not the old result.
      if (!row) return toView(ctx, await load(ctx, id));
      await audit(ctx, "tested", row);
      return toView(ctx, row);
    },

    async remove(ctx, id) {
      const existing = await load(ctx, id);
      // Admins may remove a member's personal key (offboarding); they still never see the key.
      if (!canManage(ctx, existing) && !can(ctx.actor, "member:manage")) requireManage(ctx, existing);
      const row = await deps.connections.revoke(ctx, id);
      await audit(ctx, "revoked", row);
      return { ...toView(ctx, existing), status: "invalid", canManage: false };
    },

    async resolveForExecution(ctx, input) {
      const row = await usableRow(ctx, input.connectionId, input.requestedBy, input.runtime);
      const apiKey = openKey(ctx, row, row.secretCiphertext as string);
      const ciphertext = row.secretCiphertext as string;
      return {
        apiKey,
        authMethod: row.authMethod,
        connection: toView(ctx, row),
        async storeRefreshed(secret) {
          if (!isChatGptLogin(row) || secret === apiKey) return;
          const tokens = tokensFromCodexAuthJson(secret);
          if (tokens) await storeChatGptTokens(ctx, row, ciphertext, tokens);
        },
        async markRejected() {
          if (row.authMethod === "oauth_subscription") {
            // Claude Code itself refused the token; there is no direct check to run, so trust that.
            const updated = await deps.connections.recordTest(ctx, row.id, ciphertext, {
              status: "invalid",
              lastTest: {
                ok: false,
                at: new Date(),
                latencyMs: 0,
                error: {
                  code: "UNAUTHENTICATED",
                  message: "Claude Code rejected the subscription token",
                  retryable: false,
                },
              },
            });
            if (updated) await audit(ctx, "rejected", updated);
            return;
          }
          // A 401 can come from a gateway or a short provider incident; only a direct test of this key decides.
          const result = await deps.tester.test(apiKey, row.provider);
          if (result.verdict !== "invalid") return;
          const updated = await deps.connections.recordTest(ctx, row.id, ciphertext, {
            status: "invalid",
            lastTest: toTestRecord(result),
          });
          if (!updated) return;
          await audit(ctx, "rejected", updated);
          deps.logger?.warn("provider connection marked invalid after the provider rejected the key", {
            connectionId: row.id,
            provider: row.provider,
            workspaceId: ctx.workspaceId,
          });
        },
      };
    },

    async assertUsable(ctx, connectionId, runtime) {
      return toView(ctx, await usableRow(ctx, connectionId, actorRef(ctx.actor), runtime));
    },

    async listMediaKeys(ctx) {
      assertPermission(ctx, "workspace:read");
      const rows = await mediaRows(ctx);
      return {
        storage: deps.secrets ? "available" : "unavailable",
        canManage: Boolean(deps.secrets) && can(ctx.actor, "member:manage"),
        keys: Object.keys(mediaKeyNames).map((vendor) => mediaKeyView(vendor, rows.get(vendor))),
      };
    },

    async saveMediaKey(ctx, vendor, rawInput) {
      assertPermission(ctx, "member:manage");
      requireMediaVendor(vendor);
      const { apiKey } = parse(RotateApiKeyInput, rawInput);
      assertKeyShape(mediaProvider(vendor), apiKey);
      const secrets = requireSecrets();
      const existing = (await mediaRows(ctx)).get(vendor);
      if (existing) {
        const row = await deps.connections.update(ctx, existing.id, {
          status: "unverified",
          secretCiphertext: secrets.seal(apiKey, associatedData(ctx, existing.id)),
          secretHint: apiKeyHint(existing.provider, apiKey),
        });
        await audit(ctx, "rotated", row);
        return mediaKeyView(vendor, row);
      }
      const id = newId("pcon");
      const row = await deps.connections.create(ctx, {
        id,
        provider: mediaProvider(vendor),
        authMethod: "api_key",
        ownerType: "workspace",
        label: "Workspace media key",
        // Vendors differ too much for a free check; the first media call is the test.
        status: "unverified",
        secretCiphertext: secrets.seal(apiKey, associatedData(ctx, id)),
        secretHint: apiKeyHint(mediaProvider(vendor), apiKey),
        // No agent runtime may ever spend a media key.
        runtimes: [],
        billingSource: "usage_based",
        createdBy: actorRef(ctx.actor),
      });
      await audit(ctx, "created", row);
      deps.logger?.info("workspace media key stored", {
        connectionId: id,
        vendor,
        workspaceId: ctx.workspaceId,
      });
      return mediaKeyView(vendor, row);
    },

    async removeMediaKey(ctx, vendor) {
      assertPermission(ctx, "member:manage");
      requireMediaVendor(vendor);
      const existing = (await mediaRows(ctx)).get(vendor);
      if (!existing) throw new StudixError("NOT_FOUND", `This workspace has no ${vendor} key`);
      const row = await deps.connections.revoke(ctx, existing.id);
      await audit(ctx, "revoked", row);
      return mediaKeyView(vendor, undefined);
    },

    async testMediaKey(ctx, vendor) {
      assertPermission(ctx, "member:manage");
      requireMediaVendor(vendor);
      const existing = (await mediaRows(ctx)).get(vendor);
      if (!existing) throw new StudixError("NOT_FOUND", `This workspace has no ${vendor} key`);
      const at = new Date();
      const verdict = await deps.mediaKeyTester?.(
        mediaKeyNames[vendor] as string,
        requireSecrets().open(existing.secretCiphertext as string, associatedData(ctx, existing.id)),
      );
      if (!verdict) {
        return {
          vendor,
          at,
          verdict: "unverified",
          note: "This vendor has no free key check; the first media call tests it",
        };
      }
      return { vendor, at, ...verdict };
    },

    async resolveMediaKeys(ctx) {
      if (!deps.secrets) return {};
      const values: Record<string, string> = {};
      let rows: Map<string, ProviderConnectionRecord>;
      try {
        rows = await mediaRows(ctx);
      } catch {
        return {};
      }
      for (const [vendor, row] of rows) {
        try {
          values[mediaKeyNames[vendor] as string] = deps.secrets.open(
            row.secretCiphertext as string,
            associatedData(ctx, row.id),
          );
        } catch {
          deps.logger?.error("workspace media key could not be decrypted", {
            connectionId: row.id,
            workspaceId: ctx.workspaceId,
          });
        }
      }
      return values;
    },
  };
}

function mediaProvider(vendor: string): string {
  return `${MEDIA_PROVIDER_PREFIX}${vendor}`;
}

function mediaView(
  vendor: string,
  row: ProviderConnectionRecord | undefined,
): Omit<WorkspaceMediaKeyView, "keyName" | "testable"> {
  if (!row) return { vendor, source: "platform" };
  return {
    vendor,
    source: "workspace",
    ...(row.secretHint ? { keyHint: row.secretHint } : {}),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}
