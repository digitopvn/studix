# 0004. MCP-in-MCP gateway and trust boundary

- Status: Accepted
- Date: 2026-10-27

## Context

Customers connect one Studix endpoint to their AI client. Agents also need
third-party MCP servers (research, stock assets, analytics, distribution).
Connecting each server to each client is poor AX, and flooding `tools/list`
with downstream tools wastes context. The Cloud Harness gateway pattern
(search, inspect, execute over a permission-filtered catalog) works but uses a
separate endpoint and a single-tenant trust model.

## Decision

- **Single northbound `/mcp`** (Streamable HTTP, `@modelcontextprotocol/server`
  v2 on Express 5) exposes native tools plus three meta-tools:
  `studix_tool_search(query, server?, limit?)`, `studix_tool_inspect(tool)`,
  `studix_tool_execute(tool, arguments)`. Downstream tools never enter
  `tools/list`.
- `@studix/mcp-gateway` owns registry, catalog, policy, URL policy, MCP client
  adapter, execution and invocation trace. Transport code holds no policy.
- **Workspace-scoped**: registry, catalog and grants are per workspace; there
  is no global catalog. Qualified names are `server.tool`.
- **Deny by default** for unknown, write, destructive, publishing and payment
  tools; third-party annotations are not trusted for authorization.
- **Re-authorize at execute**, independent of earlier search or inspect.
- Inbound and outbound credentials are separate boundaries; outbound uses
  `secretRef`, the inbound key is never forwarded.
- Discovery: exact name, then lexical/fuzzy; optional Jev reranking later, only
  over permission-filtered candidates. Catalog cached with TTL and generation,
  invalidated on endpoint, grant, permission or credential change.
- **Hosted mode runs no stdio servers** and installs no packages; remote
  Streamable HTTP only. SSRF, rebinding and redirect controls per
  [SECURITY.md](../SECURITY.md#ssrf-and-dns-rebinding-policy).
- **Code Mode** (`studix_code`) is P2, optional, behind a feature flag that is
  off by default, and only inside a real sandbox (not Node `vm`) after a
  security review and a benchmark showing it beats the meta-tools.

## Consequences

- `tools/list` stays small and stable regardless of how many connectors a
  workspace adds.
- Agents need one extra round trip (inspect) before calling an unfamiliar tool.
- P0 proves the path against `apps/mock-mcp`; outbound OAuth and the connector
  dashboard land in P1.

## Alternatives considered

- Separate `/mcp-gateway` endpoint: two connections for every client.
- Proxy every downstream tool into `tools/list`: context explosion and
  cross-tenant metadata risk.
- Code Mode first: larger attack surface before the simpler path is proven.
