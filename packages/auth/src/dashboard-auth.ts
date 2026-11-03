import type { IncomingHttpHeaders } from "node:http";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { Role, TenantContext, TenantDirectory } from "@studix/core";
import type { StudixDb } from "@studix/database";
import { schema } from "@studix/database";
import { type Logger, newId, StudixError } from "@studix/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { jwt } from "better-auth/plugins";
import {
  createMcpConnectionService,
  createMcpTokenVerifier,
  MCP_OAUTH_SCOPES,
  type McpConnectionService,
  type McpTokenVerifier,
  readWorkspaceSelection,
  saveWorkspaceSelection,
  WORKSPACE_CLAIM,
} from "./mcp-oauth.ts";
import { ensurePersonalWorkspace, type Membership } from "./personal-workspace.ts";

/** Prefix for application-generated ids of Better Auth rows (matches the rest of the schema's newId ids). */
const ID_PREFIX: Record<string, string> = {
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "ver",
  jwks: "jwk",
  oauthClient: "ocl",
  oauthResource: "ors",
  oauthClientResource: "ocr",
  oauthAccessToken: "oat",
  oauthRefreshToken: "ort",
  oauthConsent: "ocn",
  oauthClientAssertion: "oca",
};

/** Dashboard SSO providers Studix supports. */
export const SSO_PROVIDERS = ["github", "google"] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** Header a dashboard client may send to pick one of the user's workspaces (default: the first). */
export const WORKSPACE_HEADER = "x-studix-workspace";

export interface DashboardAuthOptions {
  db: StudixDb;
  directory: Pick<TenantDirectory, "listMemberships" | "provisionWorkspace">;
  /** Session signing secret (BETTER_AUTH_SECRET, >= 32 chars). */
  secret: string;
  /** Origin the dashboard and `/api/auth` are served from (STUDIX_APP_URL). */
  baseUrl: string;
  /** Extra origins allowed to call the auth endpoints (e.g. STUDIX_PUBLIC_URL). */
  trustedOrigins?: string[];
  /** Path the handler is mounted at. */
  basePath?: string;
  /** OAuth clients per SSO provider; a provider without one is disabled. */
  sso?: Partial<Record<SsoProvider, OAuthClientCredentials>>;
  /** Minimum password length (default 10). */
  minPasswordLength?: number;
  /** Header carrying the client IP behind a proxy, used for Better Auth's own rate limiting. */
  ipAddressHeaders?: string[];
  /** Better Auth's per-IP limiter (strict on sign-in/sign-up). Default true; tests without client IPs turn it off. */
  rateLimit?: boolean;
  /**
   * Inbound OAuth 2.1 for hosted MCP connectors (Claude, ChatGPT, ...). Omit to keep `/mcp` API-key only.
   * Better Auth is the authorization server; tokens are bound to `resource` (RFC 8707) and one workspace.
   */
  mcpOAuth?: {
    /** Canonical MCP resource URL, `<STUDIX_PUBLIC_URL>/mcp`: the only audience a token may carry. */
    resource: string;
  };
  logger?: Logger;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface DashboardSession {
  user: SessionUser;
  sessionId: string;
  expiresAt: Date;
  /** Tenant of the selected workspace; every /api call runs in it. */
  ctx: TenantContext;
  role: Role;
  memberships: Membership[];
}

/** Page the OAuth flow sends the browser to; the dashboard serves them (see `apps/dashboard`). */
const OAUTH_PAGES = {
  login: "/oauth/login",
  workspace: "/oauth/workspace",
  consent: "/oauth/consent",
} as const;

/** The slice of the plugin's post-login context the workspace choice reads. */
interface PostLoginContext {
  user: { id: string; email: string; name?: string | null };
  session: { id: string };
  isContinuation?: boolean;
}

function mcpOAuthPlugins(options: DashboardAuthOptions, issuer: string) {
  const mcpOAuth = options.mcpOAuth;
  if (!mcpOAuth) return [];
  const { db, directory, logger } = options;
  const memberships = (user: { id: string; email: string; name?: string | null }) =>
    ensurePersonalWorkspace(directory, user, logger);
  return [
    // The JWT plugin signs access tokens; its own `/token` endpoint and header stay off (OAuth provider mode).
    jwt({ disableSettingJwtHeader: true, jwt: { issuer, audience: mcpOAuth.resource } }),
    mcp({
      loginPage: OAUTH_PAGES.login,
      consentPage: OAUTH_PAGES.consent,
      resource: mcpOAuth.resource,
      scopes: [...MCP_OAUTH_SCOPES],
      resources: [{ identifier: mcpOAuth.resource, allowedScopes: [...MCP_OAUTH_SCOPES] }],
      // Hosted connectors without a Client ID Metadata Document register themselves: public clients only
      // (PKCE), this resource only, the read scope by default. CIMD below is the preferred path.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultScopes: ["studix:read"],
      clientRegistrationAllowedScopes: [...MCP_OAUTH_SCOPES],
      clientRegistrationAllowedResources: [mcpOAuth.resource],
      clientRegistrationRequirePKCE: true,
      clientRegistrationDefaultApplicationType: "infer",
      accessTokenExpiresIn: 15 * 60,
      // One grant is one workspace: the user picks it (when they have several) before consenting.
      postLogin: {
        page: OAUTH_PAGES.workspace,
        shouldRedirect: async ({ user, session, isContinuation }: PostLoginContext) => {
          const owned = await memberships(user);
          if (owned.length <= 1) return false;
          if (!isContinuation) return true;
          const picked = await readWorkspaceSelection(db, session.id);
          return !picked || !owned.some((m) => m.workspace.id === picked);
        },
        consentReferenceId: async ({ user, session }: PostLoginContext) => {
          const owned = await memberships(user);
          if (owned.length === 1) return owned[0]?.workspace.id;
          const picked = await readWorkspaceSelection(db, session.id);
          return owned.find((m) => m.workspace.id === picked)?.workspace.id;
        },
      },
      customAccessTokenClaims: ({ referenceId }: { referenceId?: string }) =>
        referenceId ? { [WORKSPACE_CLAIM]: referenceId } : {},
    } as never),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" } as never),
  ];
}

function buildBetterAuth(options: DashboardAuthOptions) {
  const { logger } = options;
  const sso = options.sso ?? {};
  const issuer = `${options.baseUrl.replace(/\/+$/, "")}${options.basePath ?? "/api/auth"}`;
  return betterAuth({
    appName: "Studix",
    baseURL: options.baseUrl,
    basePath: options.basePath ?? "/api/auth",
    secret: options.secret,
    trustedOrigins: [options.baseUrl, ...(options.trustedOrigins ?? [])],
    database: drizzleAdapter(options.db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
        jwks: schema.jwks,
        oauthClient: schema.oauthClients,
        oauthResource: schema.oauthResources,
        oauthClientResource: schema.oauthClientResources,
        oauthAccessToken: schema.oauthAccessTokens,
        oauthRefreshToken: schema.oauthRefreshTokens,
        oauthConsent: schema.oauthConsents,
        oauthClientAssertion: schema.oauthClientAssertions,
      },
    }),
    plugins: mcpOAuthPlugins(options, issuer),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: options.minPasswordLength ?? 10,
      maxPasswordLength: 256,
    },
    socialProviders: {
      ...(sso.github ? { github: { ...sso.github } } : {}),
      // Only the redirect flow (state + PKCE); Google's direct id-token sign-in stays off.
      ...(sso.google
        ? { google: { ...sso.google, prompt: "select_account" as const, disableIdTokenSignIn: true } }
        : {}),
    },
    // SSO links to an existing user only when the provider reports the email as verified (neither provider
    // is trusted blindly) and the Studix user's own email is verified too, so a password account someone
    // registered with another person's address cannot be taken over through, or used to capture, their SSO
    // sign-in. Password users link GitHub or Google from their signed-in session instead (/link-social).
    account: {
      accountLinking: { enabled: true, requireLocalEmailVerified: true, allowDifferentEmails: false },
    },
    user: {
      // No account is created from an SSO identity whose email the provider has not verified: it would hold
      // that address without proof and block its owner from signing up. Covers every OAuth entry point.
      validateUserInfo: ({ user, source }) =>
        source.method === "oauth" && source.action === "create-user" && !user.emailVerified
          ? { error: "email_not_verified", errorDescription: "The provider has not verified this email" }
          : undefined,
    },
    // OAuth errors land on the dashboard sign-in page with ?error=<code>.
    onAPIError: { errorURL: options.baseUrl },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: options.rateLimit ?? true, window: 60, max: 60 },
    telemetry: { enabled: false },
    advanced: {
      useSecureCookies: options.baseUrl.startsWith("https://"),
      cookiePrefix: "studix",
      database: { generateId: ({ model }) => newId(ID_PREFIX[model] ?? "ba") },
      ...(options.ipAddressHeaders ? { ipAddress: { ipAddressHeaders: options.ipAddressHeaders } } : {}),
    },
    logger: {
      level: "warn",
      log: (level, message) => {
        const fn = level === "error" ? "error" : level === "warn" ? "warn" : "info";
        logger?.[fn](`better-auth: ${message}`);
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Signup provisions a personal org + workspace + owner membership so the user can work at once.
          // A failure here is logged, not fatal: session resolution re-runs the same idempotent step.
          after: async (user) => {
            try {
              await ensurePersonalWorkspace(options.directory, user, logger);
            } catch (error) {
              logger?.error("personal workspace provisioning failed", {
                userId: user.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        },
      },
    },
  });
}

export type BetterAuthInstance = ReturnType<typeof buildBetterAuth>;

/** Inbound MCP OAuth surface of the auth instance; present only when `mcpOAuth` is configured. */
export interface McpOAuthSurface {
  /** Authorization server issuer, `<STUDIX_APP_URL>/api/auth`. */
  issuer: string;
  /** Canonical protected resource, `<STUDIX_PUBLIC_URL>/mcp`. */
  resource: string;
  verifier: McpTokenVerifier;
  connections: McpConnectionService;
  /** RFC 8414 authorization server metadata document for `issuer`. */
  authorizationServerMetadata(): Promise<unknown>;
  /** Remember the workspace the signed-in user picked for the authorization in progress (must be a member). */
  selectWorkspace(headers: IncomingHttpHeaders | Headers, workspaceId: string): Promise<void>;
}

export interface DashboardAuth {
  /** The Better Auth instance (exposed for tests and server-side API calls). */
  auth: BetterAuthInstance;
  /** Node handler for `${basePath}/*`; mount it before any body parser. */
  nodeHandler: ReturnType<typeof toNodeHandler>;
  /** SSO providers that have an OAuth client configured, for the sign-in page. */
  ssoProviders: SsoProvider[];
  /** Inbound MCP OAuth; undefined when not configured. */
  mcpOAuth?: McpOAuthSurface;
  /**
   * Resolve request headers (session cookie) to a session and TenantContext. Returns undefined when there is
   * no valid session. Throws FORBIDDEN when the requested workspace is not one of the user's memberships.
   */
  resolveSession(headers: IncomingHttpHeaders | Headers): Promise<DashboardSession | undefined>;
}

function toHeaders(headers: IncomingHttpHeaders | Headers): Headers {
  return headers instanceof Headers ? headers : fromNodeHeaders(headers);
}

export function createDashboardAuth(options: DashboardAuthOptions): DashboardAuth {
  if (options.secret.length < 32)
    throw new RangeError("dashboard auth secret must be at least 32 characters");
  const auth = buildBetterAuth(options);
  const issuer = `${options.baseUrl.replace(/\/+$/, "")}${options.basePath ?? "/api/auth"}`;

  const resolveSession: DashboardAuth["resolveSession"] = async (rawHeaders) => {
    const headers = toHeaders(rawHeaders);
    const result = await auth.api.getSession({ headers });
    if (!result) return undefined;
    const { user, session } = result;
    const memberships = await ensurePersonalWorkspace(options.directory, user, options.logger);
    const requested = headers.get(WORKSPACE_HEADER)?.trim();
    const selected = requested ? memberships.find((m) => m.workspace.id === requested) : memberships[0];
    if (!selected) {
      // Same answer for "does not exist" and "not a member", so workspace ids do not leak.
      throw new StudixError("FORBIDDEN", "Not a member of the requested workspace", {
        suggestedAction: "Pick one of your workspaces.",
      });
    }
    return {
      user: { id: user.id, email: user.email, name: user.name },
      sessionId: session.id,
      expiresAt: session.expiresAt,
      role: selected.member.role,
      memberships,
      ctx: {
        organizationId: selected.organization.id,
        workspaceId: selected.workspace.id,
        actor: { type: "user", id: user.id, role: selected.member.role },
      },
    };
  };

  const mcpOAuth: McpOAuthSurface | undefined = options.mcpOAuth && {
    issuer,
    resource: options.mcpOAuth.resource,
    verifier: createMcpTokenVerifier({
      db: options.db,
      directory: options.directory,
      resource: options.mcpOAuth.resource,
      issuer,
      jwks: async () => (await auth.api.getJwks()) as never,
      logger: options.logger,
    }),
    connections: createMcpConnectionService(options.db),
    authorizationServerMetadata: async () => auth.api.getOAuthServerConfig(),
    async selectWorkspace(headers, workspaceId) {
      const session = await resolveSession(headers);
      if (!session) throw new StudixError("UNAUTHENTICATED", "Sign in first");
      if (!session.memberships.some((m) => m.workspace.id === workspaceId)) {
        throw new StudixError("FORBIDDEN", "Not a member of the requested workspace");
      }
      await saveWorkspaceSelection(options.db, session.sessionId, workspaceId);
    },
  };

  return {
    auth,
    nodeHandler: toNodeHandler(auth),
    ssoProviders: SSO_PROVIDERS.filter((id) => options.sso?.[id]),
    mcpOAuth,
    resolveSession,
  };
}
