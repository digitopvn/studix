import type { IncomingHttpHeaders } from "node:http";
import type { Role, TenantContext, TenantDirectory } from "@studix/core";
import type { StudixDb } from "@studix/database";
import { schema } from "@studix/database";
import { type Logger, newId, StudixError } from "@studix/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { ensurePersonalWorkspace, type Membership } from "./personal-workspace.ts";

/** Prefix for application-generated ids of Better Auth rows (matches the rest of the schema's newId ids). */
const ID_PREFIX: Record<string, string> = {
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "ver",
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

function buildBetterAuth(options: DashboardAuthOptions) {
  const { logger } = options;
  const sso = options.sso ?? {};
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
      },
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: options.minPasswordLength ?? 10,
      maxPasswordLength: 256,
    },
    socialProviders: {
      ...(sso.github ? { github: { ...sso.github } } : {}),
      ...(sso.google ? { google: { ...sso.google, prompt: "select_account" as const } } : {}),
    },
    // SSO links to an existing user only when the provider reports the email as verified (neither provider
    // is trusted blindly) and the Studix user's own email is verified too, so a password account someone
    // registered with another person's address cannot be taken over through, or used to capture, their SSO
    // sign-in. Password users link GitHub or Google from their signed-in session instead (/link-social).
    account: {
      accountLinking: { enabled: true, requireLocalEmailVerified: true, allowDifferentEmails: false },
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
          // No account is created from an SSO identity whose email the provider has not verified: it would
          // hold that address without proof and block its owner from signing up.
          before: async (user, ctx) => {
            if (ctx?.path?.startsWith("/callback/") && !user.emailVerified) {
              logger?.warn("SSO sign-up refused: provider email is not verified");
              return false;
            }
            return { data: user };
          },
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

export interface DashboardAuth {
  /** The Better Auth instance (exposed for tests and server-side API calls). */
  auth: BetterAuthInstance;
  /** Node handler for `${basePath}/*`; mount it before any body parser. */
  nodeHandler: ReturnType<typeof toNodeHandler>;
  /** SSO providers that have an OAuth client configured, for the sign-in page. */
  ssoProviders: SsoProvider[];
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

  return {
    auth,
    nodeHandler: toNodeHandler(auth),
    ssoProviders: SSO_PROVIDERS.filter((id) => options.sso?.[id]),
    async resolveSession(rawHeaders) {
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
    },
  };
}
