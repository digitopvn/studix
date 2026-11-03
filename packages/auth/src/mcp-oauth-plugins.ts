import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { TenantDirectory } from "@studix/core";
import { jwt } from "better-auth/plugins";
import { MCP_DEFAULT_SCOPES, MCP_SUPPORTED_SCOPES } from "./mcp-oauth-scopes.ts";

/** Dashboard paths (same origin as `/api/auth`) the authorization endpoint sends the browser to. */
export const OAUTH_LOGIN_PAGE = "/oauth/login";
export const OAUTH_WORKSPACE_PAGE = "/oauth/workspace";
export const OAUTH_CONSENT_PAGE = "/oauth/consent";

/** Claim that carries the workspace a token was authorized for. */
export const WORKSPACE_CLAIM = "workspace_id";

/** Session column that remembers the workspace the user picked for the authorization in progress. */
export const SESSION_WORKSPACE_FIELD = "oauthWorkspaceId";

export interface McpOAuthOptions {
  /** Canonical MCP resource URL (`<STUDIX_PUBLIC_URL>/mcp`): the `aud` every accepted token must carry. */
  resource: string;
  /** Access token lifetime in seconds (default 600). Revocation is also checked on every request. */
  accessTokenTtlSeconds?: number;
  /** Refresh token lifetime in seconds (default 30 days). */
  refreshTokenTtlSeconds?: number;
  /** Accept Client ID Metadata Documents (https client ids) from MCP clients that use them (default true). */
  clientIdMetadataDocuments?: boolean;
  /** Accept RFC 7591 dynamic registration of public PKCE clients (default true). */
  dynamicRegistration?: boolean;
}

export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 600;
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

/** The workspace an authorization applies to, or undefined when the user must still pick one. */
async function chosenWorkspace(
  directory: Pick<TenantDirectory, "listMemberships">,
  userId: string,
  picked: unknown,
): Promise<{ workspaceId?: string; count: number }> {
  const memberships = await directory.listMemberships(userId);
  const ids = memberships.map((m) => m.workspace.id);
  if (typeof picked === "string" && ids.includes(picked)) return { workspaceId: picked, count: ids.length };
  return { workspaceId: ids.length === 1 ? ids[0] : undefined, count: ids.length };
}

/**
 * Better Auth plugins that turn the dashboard's auth into the OAuth 2.1 authorization server for `/mcp`:
 * signing keys (jwt), the provider (authorization code + PKCE S256, refresh tokens, RFC 8707 resource
 * binding, dynamic registration) and Client ID Metadata Documents. Sign-in stays the dashboard's own
 * (email/password, GitHub, Google); this only adds the OAuth endpoints around it.
 */
export function mcpOAuthPlugins(
  options: McpOAuthOptions,
  directory: Pick<TenantDirectory, "listMemberships">,
) {
  const accessTokenTtl = options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTokenTtl = options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  const dynamicRegistration = options.dynamicRegistration ?? true;
  const scopes = [...MCP_SUPPORTED_SCOPES];
  return [
    // The provider signs access tokens with these keys; the plugin's own `/token` endpoint is not needed.
    jwt({ disableSettingJwtHeader: true }),
    oauthProvider({
      loginPage: OAUTH_LOGIN_PAGE,
      consentPage: OAUTH_CONSENT_PAGE,
      scopes,
      // One protected resource. A request that names any other `resource` is refused (`invalid_target`).
      resources: [
        {
          identifier: options.resource,
          accessTokenTtl,
          allowedScopes: scopes.filter((s) => s !== "offline_access"),
        },
      ],
      accessTokenExpiresIn: accessTokenTtl,
      refreshTokenExpiresIn: refreshTokenTtl,
      codeExpiresIn: 120,
      // Secrets, codes and refresh tokens are stored as digests only.
      storeTokens: "hashed",
      storeClientSecret: "hashed",
      // Only the authorization-code (+ refresh) grants: no client credentials, no implicit.
      grantTypes: ["authorization_code", "refresh_token"],
      // MCP clients register themselves without credentials; every such client is a public PKCE client.
      allowDynamicClientRegistration: dynamicRegistration,
      allowUnauthenticatedClientRegistration: dynamicRegistration,
      clientRegistrationRequirePKCE: true,
      clientRegistrationDefaultScopes: [...MCP_DEFAULT_SCOPES],
      clientRegistrationAllowedScopes: scopes,
      clientRegistrationDefaultResources: [options.resource],
      clientRegistrationAllowedResources: [options.resource],
      // The login page needs the client's name before anyone has signed in.
      allowPublicClientPrelogin: true,
      // With several workspaces the user picks one before consent; with one it is implied.
      postLogin: {
        page: OAUTH_WORKSPACE_PAGE,
        shouldRedirect: async ({ user, isContinuation }) => {
          if (isContinuation) return false;
          return (await chosenWorkspace(directory, user.id, undefined)).count > 1;
        },
        consentReferenceId: async ({ user, session }) =>
          (await chosenWorkspace(directory, user.id, session[SESSION_WORKSPACE_FIELD])).workspaceId,
      },
      // The workspace travels with the token; the resource server still re-checks membership and consent.
      customAccessTokenClaims: ({ referenceId }) => (referenceId ? { [WORKSPACE_CLAIM]: referenceId } : {}),
    }),
    ...(options.clientIdMetadataDocuments === false
      ? []
      : [cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" })]),
  ];
}
