import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import {
  can,
  type Permission,
  ROLE_PERMISSIONS,
  type Role,
  type TenantContext,
  type TenantDirectory,
} from "@studix/core";
import { type StudixDb, schema } from "@studix/database";
import { type Logger, StudixError } from "@studix/shared";
import { and, eq, isNull } from "drizzle-orm";
import { createLocalJWKSet, type JSONWebKeySet, errors as joseErrors, jwtVerify } from "jose";
import { isApiKeyFormat, parseBearerToken } from "./api-key-format.ts";
import { WORKSPACE_CLAIM } from "./mcp-oauth-plugins.ts";
import { MCP_SUPPORTED_SCOPES, parseScopeClaim, permissionsForScopes } from "./mcp-oauth-scopes.ts";

/** JWS algorithms the authorization server signs with; anything else is refused (never `none`/HMAC). */
const ACCEPTED_ALGORITHMS = ["EdDSA", "ES256", "RS256"];
const JWKS_CACHE_MS = 5 * 60_000;
/** Unknown key ids may force a JWKS reload, but not more often than this (forged `kid` values). */
const JWKS_FORCED_REFRESH_MS = 30_000;
/** A token minted before its grant's consent existed belongs to an earlier, revoked grant. */
const CONSENT_CLOCK_TOLERANCE_MS = 2_000;
const CLOCK_TOLERANCE_SECONDS = 5;

/** What a token must carry at minimum to reach the MCP endpoint. */
export const MCP_REQUIRED_SCOPE = "studix:read";

/** Scope string a connecting client is told to request: read, write and a refresh token. */
export const MCP_CONNECT_SCOPE =
  "studix:read studix:write studix:skills:read studix:skills:write offline_access";

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ["header"];
  resource_name: string;
}

/** A client the user has authorized, as the dashboard lists it. */
export interface McpConnectionView {
  id: string;
  clientId: string;
  clientName: string;
  clientUri?: string;
  scopes: string[];
  workspaceId?: string;
  workspaceName?: string;
  organizationName?: string;
  createdAt: Date;
}

/** Why a bearer token was refused, so the HTTP layer can pick the RFC 6750 challenge. */
export type McpTokenFailure = "invalid_token" | "insufficient_scope";

export class McpTokenError extends StudixError {
  constructor(
    readonly failure: McpTokenFailure,
    message: string,
  ) {
    super(failure === "insufficient_scope" ? "FORBIDDEN" : "UNAUTHENTICATED", message, {
      suggestedAction:
        failure === "insufficient_scope"
          ? `Reconnect the app and grant the "${MCP_REQUIRED_SCOPE}" scope.`
          : "Reconnect the app to get a new access token, or use a workspace API key (stx_...).",
    });
  }
}

export interface McpOAuthDeps {
  db: StudixDb;
  directory: Pick<TenantDirectory, "listMemberships">;
  /** Canonical resource URL; tokens must be issued for exactly this audience. */
  resource: string;
  /** Issuer of the authorization server (`<STUDIX_APP_URL>/api/auth`). */
  issuer: string;
  /** Returns the JWKS the authorization server signs with. */
  jwks: () => Promise<JSONWebKeySet>;
  /** Handler for the authorization server metadata document (RFC 8414). */
  serverMetadata: (request: Request) => Promise<Response>;
  logger?: Logger;
  now?: () => Date;
}

export interface McpOAuth {
  readonly resource: string;
  readonly issuer: string;
  /** Where the protected resource metadata is served (RFC 9728 path-inserted form). */
  readonly resourceMetadataUrl: string;
  protectedResourceMetadata(): ProtectedResourceMetadata;
  /** RFC 8414 document handler. */
  serverMetadata(request: Request): Promise<Response>;
  /** True when the Authorization header carries a bearer token that is not a workspace API key. */
  isOAuthBearer(authorization: string | string[] | undefined): boolean;
  /** Verify a bearer access token and resolve it to a tenant, or throw {@link McpTokenError}. */
  authenticate(authorization: string | string[] | undefined): Promise<TenantContext>;
  listConnections(userId: string): Promise<McpConnectionView[]>;
  /** Revoke one authorization (consent and every token minted under it). Throws NOT_FOUND for others'. */
  revokeConnection(userId: string, connectionId: string): Promise<void>;
  /** Remember the workspace the signed-in user picked for the authorization in progress. */
  selectWorkspace(userId: string, sessionId: string, workspaceId: string): Promise<void>;
}

export function resourceMetadataUrlFor(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/** Permissions a token holds: the granted scopes, limited to what the user's role allows right now. */
function effectivePermissions(scopes: readonly string[], role: Role): Permission[] {
  const rolePermissions = ROLE_PERMISSIONS[role];
  return permissionsForScopes(scopes).filter((p) => rolePermissions?.has(p));
}

export function createMcpOAuth(deps: McpOAuthDeps): McpOAuth {
  const { db, directory } = deps;
  const now = deps.now ?? (() => new Date());
  let cachedKeys: { set: ReturnType<typeof createLocalJWKSet>; at: number } | undefined;

  async function keySet(forceRefresh: boolean) {
    const age = cachedKeys ? now().getTime() - cachedKeys.at : Number.POSITIVE_INFINITY;
    if (cachedKeys && (forceRefresh ? age < JWKS_FORCED_REFRESH_MS : age < JWKS_CACHE_MS))
      return cachedKeys.set;
    cachedKeys = { set: createLocalJWKSet(await deps.jwks()), at: now().getTime() };
    return cachedKeys.set;
  }

  async function verifyJwt(token: string) {
    const options = {
      issuer: deps.issuer,
      audience: deps.resource,
      algorithms: ACCEPTED_ALGORITHMS,
      requiredClaims: ["exp", "iat", "sub"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    };
    try {
      return (await jwtVerify(token, await keySet(false), options)).payload;
    } catch (error) {
      // A key rotated since the cache was filled: refresh once before refusing the token.
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
      return (await jwtVerify(token, await keySet(true), options)).payload;
    }
  }

  const invalid = (message = "Invalid access token") => new McpTokenError("invalid_token", message);

  return {
    resource: deps.resource,
    issuer: deps.issuer,
    resourceMetadataUrl: resourceMetadataUrlFor(deps.resource),
    serverMetadata: deps.serverMetadata,

    protectedResourceMetadata() {
      return {
        resource: deps.resource,
        authorization_servers: [deps.issuer],
        scopes_supported: [...MCP_SUPPORTED_SCOPES],
        bearer_methods_supported: ["header"],
        resource_name: "Studix MCP",
      };
    },

    isOAuthBearer(authorization) {
      const token = parseBearerToken(authorization);
      return token !== undefined && !isApiKeyFormat(token);
    },

    async authenticate(authorization) {
      const token = parseBearerToken(authorization);
      if (!token) throw invalid("Missing access token");
      let payload: Awaited<ReturnType<typeof verifyJwt>>;
      try {
        payload = await verifyJwt(token);
      } catch (error) {
        // Only a token problem is a 401; losing the signing keys (database down) must not look like one, or
        // clients would discard good tokens and send users back through sign-in.
        if (!(error instanceof joseErrors.JOSEError)) throw error;
        // Wrong issuer/audience, expired, bad signature, malformed: one answer, no detail about which.
        throw invalid();
      }
      const userId = payload.sub;
      const clientId = typeof payload.azp === "string" ? payload.azp : undefined;
      const workspaceId = typeof payload[WORKSPACE_CLAIM] === "string" ? payload[WORKSPACE_CLAIM] : undefined;
      if (!userId || !clientId || !workspaceId) throw invalid();

      const memberships = await directory.listMemberships(userId);
      const selected = memberships.find((m) => m.workspace.id === workspaceId);
      // Membership removed since the token was issued: the token stops working at once.
      if (!selected) throw invalid();

      // The grant must still exist (revoking a connection deletes it) and the client must not be disabled.
      const [grant] = await db
        .select({
          scopes: schema.oauthConsents.scopes,
          grantedAt: schema.oauthConsents.createdAt,
          disabled: schema.oauthClients.disabled,
        })
        .from(schema.oauthConsents)
        .innerJoin(schema.oauthClients, eq(schema.oauthClients.clientId, schema.oauthConsents.clientId))
        .where(
          and(
            eq(schema.oauthConsents.clientId, clientId),
            eq(schema.oauthConsents.userId, userId),
            eq(schema.oauthConsents.referenceId, workspaceId),
          ),
        )
        .limit(1);
      if (!grant || grant.disabled) throw invalid();
      // Revoking deletes the consent; reconnecting creates a new one. A token minted under the earlier grant
      // must not come back to life with it.
      const issuedAtMs = (payload.iat ?? 0) * 1000;
      if (grant.grantedAt && issuedAtMs + CONSENT_CLOCK_TOLERANCE_MS < grant.grantedAt.getTime())
        throw invalid();

      const granted = new Set(grant.scopes);
      const scopes = parseScopeClaim(payload.scope).filter((s) => granted.has(s));
      const permissions = effectivePermissions(scopes, selected.member.role);
      const ctx: TenantContext = {
        organizationId: selected.organization.id,
        workspaceId: selected.workspace.id,
        actor: { type: "oauth", id: userId, clientId, scopes: permissions },
      };
      if (!scopes.includes(MCP_REQUIRED_SCOPE) || !can(ctx.actor, "workspace:read")) {
        throw new McpTokenError(
          "insufficient_scope",
          "The access token does not carry the studix:read scope",
        );
      }
      return ctx;
    },

    async listConnections(userId) {
      const rows = await db
        .select({
          id: schema.oauthConsents.id,
          clientId: schema.oauthConsents.clientId,
          scopes: schema.oauthConsents.scopes,
          referenceId: schema.oauthConsents.referenceId,
          createdAt: schema.oauthConsents.createdAt,
          name: schema.oauthClients.name,
          uri: schema.oauthClients.uri,
        })
        .from(schema.oauthConsents)
        .innerJoin(schema.oauthClients, eq(schema.oauthClients.clientId, schema.oauthConsents.clientId))
        .where(eq(schema.oauthConsents.userId, userId));
      const memberships = await directory.listMemberships(userId);
      return rows
        .map((row) => {
          const membership = memberships.find((m) => m.workspace.id === row.referenceId);
          return {
            id: row.id,
            clientId: row.clientId,
            clientName: row.name ?? row.clientId,
            ...(row.uri ? { clientUri: row.uri } : {}),
            scopes: row.scopes,
            ...(row.referenceId ? { workspaceId: row.referenceId } : {}),
            ...(membership
              ? { workspaceName: membership.workspace.name, organizationName: membership.organization.name }
              : {}),
            createdAt: row.createdAt ?? new Date(0),
          };
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async revokeConnection(userId, connectionId) {
      const [consent] = await db
        .select()
        .from(schema.oauthConsents)
        .where(and(eq(schema.oauthConsents.id, connectionId), eq(schema.oauthConsents.userId, userId)))
        .limit(1);
      if (!consent) throw new StudixError("NOT_FOUND", "Connection not found");
      const revokedAt = now();
      const sameGrant = (table: typeof schema.oauthRefreshTokens | typeof schema.oauthAccessTokens) =>
        and(
          eq(table.clientId, consent.clientId),
          eq(table.userId, userId),
          consent.referenceId ? eq(table.referenceId, consent.referenceId) : isNull(table.referenceId),
        );
      await db.transaction(async (tx) => {
        await tx
          .update(schema.oauthRefreshTokens)
          .set({ revoked: revokedAt })
          .where(sameGrant(schema.oauthRefreshTokens));
        await tx
          .update(schema.oauthAccessTokens)
          .set({ revoked: revokedAt })
          .where(sameGrant(schema.oauthAccessTokens));
        await tx.delete(schema.oauthConsents).where(eq(schema.oauthConsents.id, consent.id));
      });
      deps.logger?.info("mcp oauth connection revoked", {
        clientId: consent.clientId,
        workspaceId: consent.referenceId,
      });
    },

    async selectWorkspace(userId, sessionId, workspaceId) {
      const memberships = await directory.listMemberships(userId);
      // Same answer for "does not exist" and "not a member", so workspace ids do not leak.
      if (!memberships.some((m) => m.workspace.id === workspaceId)) {
        throw new StudixError("FORBIDDEN", "Not a member of the requested workspace");
      }
      await db
        .update(schema.authSessions)
        .set({ oauthWorkspaceId: workspaceId })
        .where(and(eq(schema.authSessions.id, sessionId), eq(schema.authSessions.userId, userId)));
    },
  };
}

export { oauthProviderAuthServerMetadata };
