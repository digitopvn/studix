# Security

Status: **P0 target**. Each control names the package that owns it; the tests
in that package are the evidence. Report vulnerabilities privately to the
maintainers, not in a public issue.

## Tenancy model

`Organization -> Workspace -> Member (role)`. Every tenant-owned row carries
`organizationId` and `workspaceId`.

- Every repository method in `packages/database` takes a
  `TenantContext {organizationId, workspaceId, actor}` and filters by it. No
  unscoped query API is exported. Isolation is enforced in code, never by
  prompt ([ADR-0007](decisions/0007-tenancy-isolation.md)).
- An id from another workspace returns `NOT_FOUND`, not `FORBIDDEN`, so ids do
  not leak existence.
- Object storage keys are prefixed by tenant; signed URLs are issued only after
  a scoped repository read.
- The connector registry, tool catalog and grants are per workspace. There is
  no global catalog that could expose another tenant's tool metadata.

## API keys (inbound)

Owner: `packages/auth`.

- Format `stx_<env>_<random>`. Shown once at creation; stored as a SHA-256
  hash. Lookup is by hash.
- Revocable; revocation takes effect on the next request.
- Scoped to one workspace and a set of permissions.
- Dashboard users authenticate with sessions (Better Auth email/password) that
  resolve to a membership and then a workspace.
- Inbound OAuth for AI clients: [ADR-0006](decisions/0006-auth-and-oauth-client-compatibility.md).

## Inbound vs outbound credentials

Two independent trust boundaries:

|                 | Inbound                        | Outbound                                                             |
| --------------- | ------------------------------ | -------------------------------------------------------------------- |
| Who presents it | AI client or browser to Studix | Studix to a model, media provider or third-party MCP server          |
| Form            | `stx_` key or session          | Provider keys (server-held) or connector credentials via `secretRef` |
| Rule            | Never forwarded downstream     | Never returned to clients, prompts, logs or traces                   |

### secretRef

Connector and BYOK credentials are stored encrypted and referenced by an opaque
`secretRef`. The gateway resolves a `secretRef` only at execute time, only for
the server it belongs to, and only after the origin check. Tool schemas, search
results, traces and errors carry the reference at most, never the value.

P0 ships only operator-held references (`env:STUDIX_CONNECTOR_SECRET_<NAME>`).
Each one must be bound with `<NAME>_WORKSPACES` (who may reference it) and
`<NAME>_ORIGIN` (the only origin it is sent to); an unbound reference is
refused when the connector is added and again at resolve time. Without that
binding any self-registered workspace could point a connector at its own
server and receive the operator's token.

### Provider credentials (BYOK)

AI provider credentials are separate from connector credentials and from inbound
`stx_` keys (ADR 0011). They are sealed with AES-256-GCM, bound to the workspace and
`secretRef`, and decrypted only at execution time. Keys come from
`STUDIX_CREDENTIAL_KEYS` (`id:base64 32-byte key`, first entry active; keep old
entries to read existing secrets while rotating). Personal connections are
invisible to other members, and `secretRef` is dropped from every dashboard
projection. Pi sessions never use `~/.pi/agent` or the server environment as a
credential source.

Keys are write-only through `/api/providers`: responses carry a short hint and
are sent with `Cache-Control: no-store`. Users cannot supply a custom provider
endpoint (`baseUrl`) until outbound URLs are checked against private networks,
and providers that authenticate from ambient cloud credentials are not offered.
A failing workspace model falls back to the free rules provider, never to the
operator's paid credentials. App and worker need the same keyring.

## MCP-in-MCP connectors

Owner: `packages/mcp-gateway`
([ADR-0004](decisions/0004-mcp-in-mcp-gateway-trust-boundary.md)).

- **Deny by default.** Unknown, write, destructive, publishing and payment tools
  are denied until granted. Third-party tool annotations (such as read-only
  hints) are not trusted for authorization.
- **Re-authorize at execute.** Search and inspect results are not capabilities.
  Execute re-checks key, workspace, grant, connector state and budget.
- **Hosted transport.** Remote Streamable HTTP only. The hosted service never
  runs arbitrary stdio commands or installs server packages.
- **Caps.** Per-call timeout, concurrency, response size and schema size limits;
  oversized results are truncated or stored as asset refs.
- **No auto-retry of mutations** when the outcome is unknown and the downstream
  tool has no idempotency semantics.
- **Recursion.** A connector pointing back at Studix's own `/mcp` is rejected.

### SSRF and DNS rebinding policy

Owner: the URL policy in `packages/mcp-gateway`.

- `https` only in hosted mode; `http` allowed only for explicitly configured
  local/test hosts.
- Resolve the hostname, reject private, loopback, link-local, CGNAT, multicast,
  unspecified and cloud metadata addresses (IPv4 and IPv6, including mapped
  forms).
- Connect to the address that was validated (pin the resolution) so a second
  DNS answer cannot rebind to an internal address.
- Redirects are not followed automatically; each hop is re-validated, and
  credentials are never attached to a different origin.
- Egress from connector calls runs without Kubernetes, Docker or GPU authority.

## Prompt injection

Tool descriptions, schemas and results from third parties, uploaded briefs and
fetched content are **data**, not instructions.

- They cannot change grants, approvals, budgets or tenant context; those are
  decided in code from Postgres state.
- Downstream descriptions are length-bounded and shown as summaries in search.
- Model outputs that drive decisions are schema-validated; security, cost,
  publish and approval decisions fail closed when no valid decision exists
  ([ADR-0003](decisions/0003-jev-decision-provider-adapter-and-routing-fallback.md)).
- Credentials are never placed in prompts, so an injected instruction has
  nothing to exfiltrate from model context.

## Approval gates

Owner: `ApprovalPolicy` in `packages/core`, enforced by `packages/workflow`.

- Publishing and high-cost actions require a recorded human approval. Missing
  approval returns `APPROVAL_REQUIRED`; there is no auto-approval.
- Approval state lives in Postgres and survives worker restarts.
- A render that succeeds is not an approval.

## Artifacts and signed URLs

Owner: `packages/storage`.

- Artifacts are private objects; clients receive short-lived presigned URLs.
- URL lifetime is configuration; tests assert expiry.
- Uploads (when added) are validated by type and size before use.

## Worker isolation

The reference project's Pi path guard limits file tools to a directory but is
not a process sandbox ([PORTING.md](PORTING.md)). Studix does not rely on `cwd`
or a path guard as a security boundary:

- Agent and render work run only in the `worker` role, in its own pod/container.
- No shell tool is exposed through public MCP; no arbitrary terminal access.
- Workers get only the credentials their stages need; the app role holds no
  provider keys it does not use.
- Code Mode, if ever enabled, requires a real sandbox and is off by default (P2).

## Redaction

Owner: `redact()` and the logger in `packages/shared`, spans in
`packages/observability`.

- Logs, traces, errors and usage records redact credentials, `stx_` keys,
  bearer/basic headers, connector secrets and known provider key shapes.
- Raw prompts and downstream payloads are not logged by default; traces record
  provider, model, latency, tokens, cost, bytes and outcome.

## Threat list

Each item maps to a negative test in the owning package.

| Threat                                                 | Control                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Cross-tenant read/write                                | `TenantContext` in every repository call; tenant A/B tests             |
| Stolen or leaked API key                               | Hashed storage, revocation, scopes, redaction                          |
| Inbound credential forwarded downstream                | Separate outbound credentials via `secretRef`                          |
| `secretRef` value leak                                 | Resolution only at execute, never serialized                           |
| SSRF to internal or metadata IPs                       | URL policy, IP range denylist                                          |
| DNS rebinding                                          | Pinned resolution                                                      |
| Redirect to internal host or wrong origin              | Manual redirect handling, origin-bound credentials                     |
| Malicious tool description / result (prompt injection) | Data-not-instruction rule, bounded summaries, code-side authorization  |
| Permission changed after search                        | Re-authorization at execute                                            |
| Disabled or revoked tool still callable                | Catalog invalidation and execute-time check                            |
| Recursion through Studix's own `/mcp`                  | Self-reference rejection                                               |
| Oversized result or schema                             | Size caps, truncation, asset refs                                      |
| Duplicate side effects on retry                        | Idempotency keys, no auto-retry of unknown-outcome mutations           |
| Duplicate billing on retry                             | Usage dedupe keys ([ADR-0008](decisions/0008-billing-usage-ledger.md)) |
| Publish or high-cost action without approval           | `ApprovalPolicy`, fail closed                                          |
| Runaway cost                                           | Budgets checked before each costly stage                               |
| Agent escaping its workspace                           | Worker pod isolation, no shell, scoped credentials                     |
| Expired artifact URL still valid                       | Presign expiry tests                                                   |
| Host header / origin spoofing                          | Host allow-list derived from `STUDIX_*_URL`                            |
