import type { Member, Permission, Role, TenantContext, TenantDirectory } from "@studix/core";
import { OAUTH_OFFLINE_SCOPE, OAUTH_SCOPES, ROLE_PERMISSIONS } from "@studix/core";
import type { StudixDb } from "@studix/database";
import { schema } from "@studix/database";
import { type Clock, type Logger, newId, StudixError, systemClock } from "@studix/shared";
import { and, eq, gt } from "drizzle-orm";
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose";
import type { Membership } from "./personal-workspace.ts";

/** Scopes the authorization server advertises and accepts: ours plus the standard refresh-token scope. */
export const MCP_OAUTH_SCOPES: readonly string[] = [...Object.keys(OAUTH_SCOPES), OAUTH_OFFLINE_SCOPE];

/** Claim carrying the workspace a token is bound to (the consent's reference id). */
export const WORKSPACE_CLAIM = "https://studix.digitop.ai/workspace";

const SELECTION_PREFIX = "mcp-workspace:";
const SELECTION_TTL_MS = 10 * 60 * 1000;

/** RFC 8414 metadata path for an issuer with a path component (`/api/auth` -> `/.well-known/...-server/api/auth`). */
export function authorizationServerMetadataPath(issuer: string): string {
  const path = new URL(issuer).pathname.replace(/\/+$/, "");
  return `/.well-known/oauth-authorization-server${path}`;
}

/** RFC 9728 metadata path for a resource with a path component (`/mcp` -> `/.well-known/...-resource/mcp`). */
export function protectedResourceMetadataPath(resource: string): string {
  const path = new URL(resource).pathname.replace(/\/+$/, "");
  return `/.well-known/oauth-protected-resource${path}`;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ["header"];
  resource_name: string;
  resource_documentation?: string;
}

export function protectedResourceMetadata(resource: string, issuer: string): ProtectedResourceMetadata {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Studix MCP",
  };
}

/** The permissions a scope list stands for (unknown scopes and `offline_access` stand for none). */
export function permissionsForScopes(scopes: readonly string[]): Permission[] {
  const out = new Set<Permission>();
  for (const scope of scopes) for (const permission of OAUTH_SCOPES[scope] ?? []) out.add(permission);
  return [...out];
}

/** Effective permissions of an OAuth grant: the granted scopes narrowed by the member's current role. */
export function effectivePermissions(scopes: readonly string[], role: Role): Permission[] {
  const rolePermissions = ROLE_PERMISSIONS[role];
  return permissionsForScopes(scopes).filter((permission) => rolePermissions.has(permission));
}

/** Workspace the user picked for the authorization in progress on this session (10 minutes). */
export async function saveWorkspaceSelection(
  db: StudixDb,
  sessionId: string,
  workspaceId: string,
  clock: Clock = systemClock,
): Promise<void> {
  const identifier = `${SELECTION_PREFIX}${sessionId}`;
  const now = clock.now();
  await db.transaction(async (tx) => {
    await tx.delete(schema.authVerifications).where(eq(schema.authVerifications.identifier, identifier));
    await tx.insert(schema.authVerifications).values({
      id: newId("ver"),
      identifier,
      value: workspaceId,
      expiresAt: new Date(now.getTime() + SELECTION_TTL_MS),
    });
  });
}

export async function readWorkspaceSelection(
  db: StudixDb,
  sessionId: string,
  clock: Clock = systemClock,
): Promise<string | undefined> {
  const rows = await db
    .select({ value: schema.authVerifications.value })
    .from(schema.authVerifications)
    .where(
      and(
        eq(schema.authVerifications.identifier, `${SELECTION_PREFIX}${sessionId}`),
        gt(schema.authVerifications.expiresAt, clock.now()),
      ),
    )
    .limit(1);
  return rows[0]?.value;
}

/** One workspace grant of the signed-in user to an AI client, as the dashboard lists it. */
export interface McpConnection {
  id: string;
  clientId: string;
  clientName: string;
  workspaceId: string;
  scopes: string[];
  createdAt: Date;
}

export interface McpConnectionService {
  list(userId: string): Promise<McpConnection[]>;
  /** Revoke one grant: the consent, its refresh tokens and stored access tokens. Returns false when not the user's. */
  revoke(userId: string, consentId: string): Promise<boolean>;
}

export function createMcpConnectionService(db: StudixDb): McpConnectionService {
  return {
    async list(userId) {
      const rows = await db
        .select({
          id: schema.oauthConsents.id,
          clientId: schema.oauthConsents.clientId,
          clientName: schema.oauthClients.name,
          referenceId: schema.oauthConsents.referenceId,
          scopes: schema.oauthConsents.scopes,
          createdAt: schema.oauthConsents.createdAt,
        })
        .from(schema.oauthConsents)
        .innerJoin(schema.oauthClients, eq(schema.oauthClients.clientId, schema.oauthConsents.clientId))
        .where(eq(schema.oauthConsents.userId, userId));
      return rows
        .filter((row) => row.referenceId)
        .map((row) => ({
          id: row.id,
          clientId: row.clientId,
          clientName: row.clientName ?? row.clientId,
          workspaceId: row.referenceId as string,
          scopes: row.scopes,
          createdAt: row.createdAt,
        }));
    },

    async revoke(userId, consentId) {
      return db.transaction(async (tx) => {
        const [consent] = await tx
          .select()
          .from(schema.oauthConsents)
          .where(and(eq(schema.oauthConsents.id, consentId), eq(schema.oauthConsents.userId, userId)))
          .limit(1);
        if (!consent) return false;
        const sameGrant = <T extends { userId: unknown; clientId: unknown; referenceId: unknown }>(
          table: T,
        ) =>
          and(
            eq(table.userId as never, userId),
            eq(table.clientId as never, consent.clientId),
            consent.referenceId ? eq(table.referenceId as never, consent.referenceId) : undefined,
          );
        await tx.delete(schema.oauthAccessTokens).where(sameGrant(schema.oauthAccessTokens));
        await tx.delete(schema.oauthRefreshTokens).where(sameGrant(schema.oauthRefreshTokens));
        await tx.delete(schema.oauthConsents).where(eq(schema.oauthConsents.id, consentId));
        return true;
      });
    },
  };
}

export interface McpTokenVerifierDeps {
  db: StudixDb;
  directory: Pick<TenantDirectory, "listMemberships">;
  /** Canonical resource URL (`<STUDIX_PUBLIC_URL>/mcp`): the only audience a token may carry. */
  resource: string;
  /** Authorization server issuer (`<STUDIX_APP_URL>/api/auth`). */
  issuer: string;
  /** The auth server's current public signing keys. */
  jwks: () => Promise<JSONWebKeySet>;
  clock?: Clock;
  logger?: Logger;
  /** How long a fetched key set is reused (default 60s). */
  jwksTtlMs?: number;
}

export interface McpTokenVerifier {
  /** Verify a bearer access token and build the TenantContext, or throw UNAUTHENTICATED. */
  authenticate(token: string): Promise<TenantContext & { scopes: string[] }>;
}

function invalidToken(message = "Invalid access token"): StudixError {
  // Fixed text: the presented token is never echoed back.
  return new StudixError("UNAUTHENTICATED", message, {
    suggestedAction: "Reconnect the client to Studix to obtain a new access token.",
  });
}

function activeMember(memberships: Membership[], workspaceId: string): Membership | undefined {
  return memberships.find((m) => m.workspace.id === workspaceId);
}

export function createMcpTokenVerifier(deps: McpTokenVerifierDeps): McpTokenVerifier {
  const clock = deps.clock ?? systemClock;
  const ttl = deps.jwksTtlMs ?? 60_000;
  let cached: { at: number; keys: ReturnType<typeof createLocalJWKSet> } | undefined;

  async function keys(force = false) {
    if (!force && cached && clock.now().getTime() - cached.at < ttl) return cached.keys;
    cached = { at: clock.now().getTime(), keys: createLocalJWKSet(await deps.jwks()) };
    return cached.keys;
  }

  async function verify(token: string) {
    const options = {
      issuer: deps.issuer,
      audience: deps.resource,
      currentDate: clock.now(),
      clockTolerance: 5,
    };
    try {
      return await jwtVerify(token, await keys(), options);
    } catch (error) {
      // A key rotated since the cached set was fetched: refetch once before rejecting.
      if (error instanceof Error && error.name === "JWKSNoMatchingKey") {
        return jwtVerify(token, await keys(true), options);
      }
      throw error;
    }
  }

  return {
    async authenticate(token) {
      let payload: Awaited<ReturnType<typeof verify>>["payload"];
      try {
        ({ payload } = await verify(token));
      } catch {
        throw invalidToken();
      }
      const userId = typeof payload.sub === "string" ? payload.sub : undefined;
      const clientId = typeof payload.azp === "string" ? payload.azp : undefined;
      const workspaceId = payload[WORKSPACE_CLAIM];
      const scopeClaim = typeof payload.scope === "string" ? payload.scope : "";
      if (!userId || !clientId || typeof workspaceId !== "string") throw invalidToken();
      const scopes = scopeClaim.split(" ").filter(Boolean);

      // The grant must still exist: revoking a connection ends access at once, not at token expiry.
      const consents = await deps.db
        .select({ scopes: schema.oauthConsents.scopes })
        .from(schema.oauthConsents)
        .where(
          and(
            eq(schema.oauthConsents.userId, userId),
            eq(schema.oauthConsents.clientId, clientId),
            eq(schema.oauthConsents.referenceId, workspaceId),
          ),
        )
        .limit(1);
      const consent = consents[0];
      if (!consent) throw invalidToken();
      // A token never outlives a narrowed grant.
      const granted = scopes.filter((scope) => consent.scopes.includes(scope));

      const membership = activeMember(await deps.directory.listMemberships(userId), workspaceId);
      if (!membership) throw invalidToken();
      const member: Member = membership.member;

      const permissions = effectivePermissions(granted, member.role);
      return {
        organizationId: membership.organization.id,
        workspaceId: membership.workspace.id,
        actor: { type: "oauth", id: userId, clientId, scopes: permissions },
        scopes: granted,
      };
    },
  };
}
