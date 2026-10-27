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

Plan (OAuth for AI clients):

- Serve OAuth 2.0 protected-resource metadata for `/mcp` pointing to an
  authorization server, and return a `WWW-Authenticate` challenge on 401, per
  the MCP authorization specification pinned with the SDK version.
- Access tokens resolve to the same workspace and scopes as API keys; API keys
  remain for SDKs and automation.
- Redirect URIs, issuer and resource URLs derive from `STUDIX_*_URL`.

Verification plan before declaring OAuth support:

1. Protocol tests: metadata discovery, 401 challenge, token audience/resource
   binding, expired and revoked tokens, scope downgrade.
2. Client matrix: Claude custom connector (web and Desktop), ChatGPT connector,
   Claude Code, TS SDK, Python SDK; record the result for each.
3. Cutover test: the same flow after changing `STUDIX_*_URL` to new hostnames.

## Consequences

- P0 supports Claude Code, SDKs and header-capable bridges; hosted custom
  connectors wait for OAuth ([MCP_API.md](../MCP_API.md#connecting-a-client)).
- Outbound OAuth for third-party connectors is a separate design (P1,
  ADR-0004).

## Alternatives considered

- Ship OAuth in P0: larger scope before the vertical slice exists.
- Authless `/mcp`: unacceptable for a multi-tenant service.
