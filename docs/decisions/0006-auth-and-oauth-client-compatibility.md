# 0006. Auth and OAuth client compatibility

- Status: Accepted
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

OAuth for AI clients (shipped; MCP authorization spec 2026-07-28):

- The authorization server is Better Auth (`@better-auth/mcp`, `jwt()` and
  `@better-auth/cimd`) at `<STUDIX_APP_URL>/api/auth`, on the same user table
  and session as the dashboard. `/mcp` is a protected resource only: it
  verifies tokens and never issues them.
- Discovery: RFC 9728 protected resource metadata at
  `/.well-known/oauth-protected-resource` and the path form
  `/.well-known/oauth-protected-resource/mcp`; RFC 8414 metadata at
  `/.well-known/oauth-authorization-server/api/auth`. An unauthenticated
  `/mcp` call answers `401` with `WWW-Authenticate: Bearer resource_metadata=..., scope=...`
  (RFC 6750; `error` only when a credential was sent).
- Client registration: Client ID Metadata Documents (URL client ids) and
  dynamic client registration for public clients with PKCE only. No
  confidential or `client_credentials` clients are registered.
- Flow: authorization code with PKCE `S256` and an RFC 8707 `resource`
  parameter. Access tokens are 15-minute JWTs signed with a key from the
  database JWKS, `aud` = `<STUDIX_PUBLIC_URL>/mcp`, plus a workspace claim.
  Refresh tokens rotate.
- A user picks one workspace on `/oauth/workspace`; the grant is bound to it
  (the consent row's `referenceId`). The verifier checks issuer, audience,
  expiry and signature locally, then that the consent still exists and the
  user is still a member, so revoking a connection or leaving the workspace
  takes effect at once. Effective permissions are
  `granted scopes ∩ consented scopes ∩ role`; `studix:read` maps to the read
  permissions and `studix:write` to the editor set (never key or member
  administration). Insufficient scope answers `403 insufficient_scope`.
- `stx_` API keys are unchanged and are selected by prefix; a bearer token
  never falls back to the other path, and an unauthenticated call never
  becomes anonymous. Inbound tokens are never forwarded to connectors or
  provider APIs (downstream credentials only come from `secretRef`).
- Users list and revoke connected apps under Account; revoking deletes the
  consent and its tokens.
- Issuer and resource derive from `STUDIX_APP_URL` and `STUDIX_PUBLIC_URL`.

Verification:

1. Protocol tests (`apps/mcp-server/test/mcp-oauth.integration.test.ts`,
   `packages/auth/test/mcp-token-verifier.integration.test.ts`, real Postgres,
   real HTTP): discovery and challenge, registration limits, the full
   code+PKCE flow, `tools/list` and `studix_inspect` with a token via the
   TypeScript SDK, refresh rotation, revoke, scope downgrade, wrong issuer,
   audience and resource, expired and foreign-signed tokens, key rotation,
   redirect mismatch, PKCE and replay failures, cross-workspace access and
   `stx_` keys alongside.
2. Client matrix. Verified: TypeScript SDK (automated). `stx_` key path with
   the Python SDK and Claude Code (existing tests, unchanged). Not verified
   in this change: Claude custom connector (web and Desktop), ChatGPT
   connector, and the OAuth flow from the Python SDK and Claude Code; they
   need hosted accounts and a public HTTPS hostname. Run them after deploy
   and record the result here.
3. Cutover test: not run against real hostnames. Tests derive every URL from
   a dynamic base, so nothing is hardcoded; repeat the discovery check after
   changing `STUDIX_*_URL`.

## Consequences

- Claude Code, SDKs and header-capable bridges keep using API keys; hosted
  custom connectors use OAuth ([MCP_API.md](../MCP_API.md#connecting-a-client)).
- Migration `0020_mcp_oauth` adds the OAuth tables (additive only).
- Outbound OAuth for third-party connectors is a separate design (P1,
  ADR-0004).

## Alternatives considered

- Ship OAuth in P0: larger scope before the vertical slice exists.
- Authless `/mcp`: unacceptable for a multi-tenant service.
