# 0006. Auth and OAuth client compatibility

- Status: Accepted (inbound OAuth implemented 2026-11-03)
- Date: 2026-10-27

## Context

AI clients connect to `/mcp`; humans use the dashboard. SDK clients and Claude
Code can send a static `Authorization` header, but hosted custom connectors in
Claude and ChatGPT expect MCP authorization (OAuth) or no auth. `motion-mcp`
had bearer-only static keys with no OAuth.

## Decision

Now (P0):

- `/mcp` requires a workspace API key `stx_<env>_<random>`, stored as a SHA-256
  hash, revocable and scoped. Auth is on by default in production.
- Dashboard uses Better Auth email/password sessions; session -> membership ->
  workspace.
- Both paths produce the same `TenantContext` for the service layer.

Inbound OAuth 2.1 for AI clients (implemented):

- The dashboard's Better Auth instance is also the authorization server for
  `/mcp`, through the `jwt`, `@better-auth/oauth-provider` and
  `@better-auth/cimd` plugins. No identity system is hand-written. Dashboard
  sign-in (email/password, GitHub, Google) is reused as the login step; the
  authorization server is a separate role with its own clients, consents and
  tokens.
- Discovery: RFC 9728 protected resource metadata at
  `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/mcp`; RFC 8414 authorization server
  metadata at `/.well-known/oauth-authorization-server/api/auth` (issuer
  `<STUDIX_APP_URL>/api/auth`). An unauthenticated or invalid `/mcp` request
  answers `401` with
  `WWW-Authenticate: Bearer realm="studix", resource_metadata="...", scope="studix:read"`
  (plus `error="invalid_token"` when a token was sent); a token without
  `studix:read` answers `403` with `error="insufficient_scope"`.
- Flow: authorization code with PKCE `S256` only, exact redirect URI match,
  signed authorization query (`sig`, `exp`) carried through login, workspace
  and consent pages, short-lived single-use codes. Clients identify themselves
  by Client ID Metadata Document (https client id) or register dynamically as
  public PKCE clients (RFC 7591). Client secrets and tokens are stored hashed.
- Tokens: JWT access tokens (10 minutes) bound to the resource by RFC 8707
  (`aud` is exactly `<STUDIX_PUBLIC_URL>/mcp`), carrying `azp` (client) and
  `workspace_id`. Refresh tokens (30 days) require the `offline_access` scope.
  A request without `resource` yields an opaque token that `/mcp` refuses.
- Authorization on every request: signature and `iss`/`aud`/`exp` are checked
  locally against the JWKS; then the user's current membership of the token's
  workspace, a live consent row for the client (revoking a connection deletes
  it and revokes its tokens, so it stops at once) and a non-disabled client.
  Effective permissions are the intersection of the token scope, the consent
  and the user's current role. The result is a `TenantContext` whose actor is
  `oauth` (never `user`, so approvals stay human-only; no `apikey:manage`,
  `member:manage`, `publish` or operator permission is reachable).
- Scopes: `studix:read` (workspace, project and asset reads), `studix:write`
  (project writes, job cancel/retry, asset writes, approval requests),
  `offline_access`.
- The workspace is chosen by the signed-in user on the authorization step (one
  workspace is implied). Tokens are never forwarded to connectors or
  providers: outbound credentials stay separate (ADR-0004).
- API keys are unchanged: a bearer shaped `stx_...` is always checked as an API
  key; anything else is treated as an OAuth access token. There is no anonymous
  fallback. `STUDIX_MCP_OAUTH=false` turns OAuth off and leaves keys only.
- Redirect URIs, issuer and resource derive from `STUDIX_APP_URL` and
  `STUDIX_PUBLIC_URL`; no callback needs to be registered with GitHub or Google
  for this, since the dashboard login reuses the existing SSO callbacks.

Verification before declaring OAuth support:

1. Protocol tests: metadata discovery, 401/403 challenge, token audience/resource
   binding, expired and revoked tokens, scope downgrade.
2. Client matrix: Claude custom connector (web and Desktop), ChatGPT connector,
   Claude Code, TS SDK, Python SDK; record the result for each.
3. Cutover test: the same flow after changing `STUDIX_*_URL` to new hostnames.

### Verification status

Verified by automated tests on real Postgres with a real HTTP app
(`apps/mcp-server/test/mcp-oauth.integration.test.ts`; no paid provider):

- Discovery documents, CORS for browser clients, the 401 and 403 challenges.
- Dynamic registration, authorization code + PKCE, consent, token exchange,
  and `tools/list` / `studix_inspect` through the TypeScript SDK client with the
  resulting access token.
- Rejections: reused code, wrong PKCE verifier, unknown `resource`, redirect
  mismatch, token without resource, wrong issuer, wrong audience, expired,
  foreign signature, unknown client, workspace the user is not a member of,
  insufficient scope, scope wider than the consent, revoked connection (access
  and refresh), another user's connection, membership removed.
- `stx_` keys keep working, and an invalid `stx_` key still answers 401.

Not verified in this change (needs access to the hosted clients or a deployed
URL): Claude custom connector (web/Desktop), ChatGPT connector, Claude Code
`/mcp` OAuth login, the Python SDK with an OAuth token, CIMD against a real
client, and the `STUDIX_*_URL` cutover. Record each result here once run.

## Consequences

- Claude Code, SDKs and header-capable bridges can keep using API keys; OAuth
  clients connect with just the URL ([MCP_API.md](../MCP_API.md#connecting-a-client)).
- Existing deployments migrate by running the additive database migration and
  deploying; nothing needs to change for API-key clients. Changing
  `STUDIX_PUBLIC_URL` changes the resource identifier, so clients reconnect.
- Outbound OAuth for third-party connectors is a separate design (P1,
  ADR-0004).

## Alternatives considered

- Ship OAuth in P0: larger scope before the vertical slice exists.
- Authless `/mcp`: unacceptable for a multi-tenant service.
