import { boolean, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./columns.ts";
import { authSessions, users } from "./tenancy.ts";

/**
 * Tables of the Better Auth `jwt` and `oauth-provider` plugins, which make the app the OAuth 2.1
 * authorization server for `/mcp`. Property names are the plugin's field names (the Drizzle adapter maps
 * by them); column names follow the schema's snake_case convention. Secrets, authorization codes and
 * tokens are stored as digests by the plugin (`storeTokens: "hashed"`); signing keys are encrypted with
 * BETTER_AUTH_SECRET.
 */

/** Token signing keys, published at `/api/auth/jwks`. */
export const authJwks = pgTable("auth_jwks", {
  id: id(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: createdAt(),
  expiresAt: ts("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
});

/** OAuth clients: dynamically registered, or discovered from a Client ID Metadata Document. */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: id(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("client_credentials_scopes").array().default([]),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").defaultNow(),
    updatedAt: ts("updated_at").defaultNow(),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauth_clients_user_idx").on(t.userId)],
);

/** Protected resources tokens may be issued for (RFC 8707): the MCP endpoint. */
export const oauthResources = pgTable("oauth_resources", {
  id: id(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
  disabled: boolean("disabled").default(false),
  createdAt: ts("created_at").defaultNow(),
  updatedAt: ts("updated_at").defaultNow(),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResources = pgTable(
  "oauth_client_resources",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: ts("created_at").defaultNow(),
  },
  (t) => [
    index("oauth_client_resources_client_idx").on(t.clientId),
    index("oauth_client_resources_resource_idx").on(t.resourceId),
  ],
);

/** What a user granted a client, per workspace (`referenceId` is the workspace id). Deleting it revokes. */
export const oauthConsents = pgTable(
  "oauth_consents",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: ts("created_at").defaultNow(),
    updatedAt: ts("updated_at").defaultNow(),
  },
  (t) => [index("oauth_consents_client_idx").on(t.clientId), index("oauth_consents_user_idx").on(t.userId)],
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: id(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => authSessions.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").defaultNow(),
    revoked: ts("revoked"),
    rotatedAt: ts("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: ts("rotation_replay_expires_at"),
    authTime: ts("auth_time"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_refresh_tokens_client_idx").on(t.clientId),
    index("oauth_refresh_tokens_user_idx").on(t.userId),
    index("oauth_refresh_tokens_session_idx").on(t.sessionId),
    index("oauth_refresh_tokens_code_idx").on(t.authorizationCodeId),
  ],
);

/** Opaque access tokens (only issued when no resource is requested; the MCP endpoint accepts JWTs only). */
export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: id(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => authSessions.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: text("refresh_id").references(() => oauthRefreshTokens.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").defaultNow(),
    revoked: ts("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_access_tokens_client_idx").on(t.clientId),
    index("oauth_access_tokens_user_idx").on(t.userId),
    index("oauth_access_tokens_session_idx").on(t.sessionId),
    index("oauth_access_tokens_code_idx").on(t.authorizationCodeId),
    index("oauth_access_tokens_refresh_idx").on(t.refreshId),
  ],
);

/** Replay tombstones for client assertions (single-use `jti`). */
export const oauthClientAssertions = pgTable("oauth_client_assertions", {
  id: id(),
  expiresAt: ts("expires_at").notNull(),
});
