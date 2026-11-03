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
- Dashboard users authenticate with sessions (Better Auth email/password, or
  GitHub / Google SSO when configured) that resolve to a membership and then a
  workspace. SSO runs only the redirect flow: Better Auth's `state` check bound
  to a browser cookie, plus PKCE for both providers (Google's direct id-token
  sign-in is disabled).
- SSO links to an existing user only when the provider reports the email as
  verified and the Studix user's own email is verified (a user created through
  SSO). Password accounts are never linked implicitly, since sign-up does not
  verify email: their owners link GitHub or Google from the dashboard Account
  page while signed in, with the same verified email. An SSO identity whose
  email the provider has not verified never creates an account.
- Because sign-up does not verify email, anyone can register a password
  account with someone else's address, and the owner's SSO sign-in then stops
  at `account_not_linked`. An operator recovers the address by deleting that
  unverified password user (after checking it holds no work of the owner), so
  the owner's next SSO sign-in creates a fresh account.
- Inbound OAuth for AI clients ([ADR-0006](decisions/0006-auth-and-oauth-client-compatibility.md)):
  `/mcp` accepts either an `stx_` key or an OAuth access token, never both
  and never neither. Tokens are short-lived JWTs verified for issuer,
  audience (`<STUDIX_PUBLIC_URL>/mcp`), expiry and signature, then against the
  live consent and workspace membership, so revoking a connection or leaving
  the workspace cuts access at once. Permissions are the intersection of the
  granted scopes, the consented scopes and the user's role. Registration is
  limited to public PKCE clients; redirect URIs match exactly. Token
  endpoints are cookie-less and rate limited. Failures return fixed text;
  tokens, codes and secrets are never logged. The access token is never
  forwarded to a connector or provider API.

## Rate limiting

Owner: `apps/mcp-server` (`http/rate-limit.ts`), store in `packages/database`.

- Token buckets live in the Postgres table `rate_limit_buckets`, updated with one
  atomic upsert on the database clock, so limits hold across app replicas and
  survive restarts.
- Keys: `/mcp` per workspace after the key is verified (the real quota) plus a
  generous per-IP flood guard before it (hosted AI clients share egress IPs
  across tenants); `/api/auth` and `/api` per client IP. IPv6 clients share one
  bucket per /64. The IP comes from `STUDIX_TRUST_PROXY`, so set it when the app
  runs behind an ingress.
- Refused keys are remembered in process until a token can exist again, so a
  flood of refused requests costs no database writes.
- If the store errors or takes longer than 250 ms, the call is decided by a
  per-process bucket, so limits temporarily multiply by replica count but
  requests are never held on the store. The warning is logged at most every 30 s.
- Idle buckets (an hour, far beyond refill) are pruned by one pruner per process.

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

### Anthropic provider credentials

Workspaces connect Claude through **AI & Providers** in the dashboard
([ADR-0011](decisions/0011-claude-agent-runtime-and-provider-auth.md)). The
two auth methods are separate and are never used as each other's fallback:

- **Anthropic API key**, billed by usage to the key's Anthropic organization.
  The key is tested before it is saved, with `GET /v1/models`, which runs no
  model. A key Anthropic rejects is not stored. An accepted key is sealed with
  AES-256-GCM under `STUDIX_SECRETS_KEY`. The associated data binds the
  ciphertext to its organization, workspace and connection id, so a row copied
  to another tenant does not decrypt.
- Responses, audit events and logs carry only a hint (`sk-ant-…` plus the last
  4 characters). All provider routes send `Cache-Control: no-store`. Removing a
  key deletes the ciphertext but does not revoke the key at Anthropic; revoke
  it in Claude Console.
- Who can do what:
  - Workspace keys can be managed only with `member:manage` (owner or admin).
  - A personal key belongs to its user. It is released for execution only for
    jobs that user created, and never as a fallback for anyone else. Removing the
    member from the workspace revokes their personal keys.
- **Running Claude in the worker.** A job uses a key only when it selected that
  connection (`planner.providerConnectionId`). The key is opened in the worker
  for that run and passed to the Agent SDK subprocess only as
  `ANTHROPIC_API_KEY`. The subprocess:
  - gets a minimal environment, so the database URL, storage keys and the
    master key are not inherited;
  - runs in a fresh temporary directory that is deleted afterwards;
  - loads no user, project or local settings and no MCP servers;
  - has no tools, and every tool request is denied;
  - is capped per attempt by turns, cost (never above the job's remaining
    budget) and a deadline, and is interrupted then killed on cancel, lease
    loss or shutdown; worker shutdown waits for that process to exit;
  - bills what a failed run already spent to the job, and a run that spent
    anything is not retried, so a retry never pays twice.

  The brief is passed as delimited data, never as instructions. The output is
  accepted only after `validateVideoIR`.
- **Claude subscription (OAuth)** stays _Restricted_. Anthropic does not allow
  third-party products to offer claude.ai login or route requests through
  subscription credentials without approval. The dashboard therefore shows the
  reason and the alternatives, and offers no connect action.
- Master-key rotation:
  1. Move the old value into `STUDIX_SECRETS_KEYS_PREVIOUS`.
  2. Set a new `STUDIX_SECRETS_KEY`.
  3. Each sealed value records its key id, so existing rows keep decrypting
     until they are re-saved.

### Keys for the Pi runtime and model preferences

Keys for other providers (OpenAI, Google, OpenRouter and others) use the same
sealed storage, hints and permissions as Anthropic keys
([ADR-0016](decisions/0016-provider-connections-runtimes-and-model-preferences.md)).
On top of that:

- Each key lists the runtimes allowed to spend it. Keys saved before this
  existed are enabled for Claude only; Pi can use them only after whoever
  manages the key enables it. Claude never runs a non-Anthropic key.
- Testing a non-Anthropic key sends one short prompt to the provider's cheapest
  model, capped at 1 cent, because most providers have no free check.
- A workspace-wide model choice may only use workspace keys, so one member's
  personal key never becomes everyone's default.
- Each Pi attempt runs in-process with an in-memory auth store that holds only
  the resolved key. It has no tools, reads no `~/.pi` files, settings,
  extensions or context files, and does not fall back to environment
  credentials (an empty key is refused). The key is registered for log
  redaction and cut out of provider error messages before they are kept.
- Fallback to another key happens only when the preference opted in, and only
  for a failure at the provider. A key the provider rejects is marked invalid.
- The model a job uses is pinned at its first attempt. The snapshot stores ids
  and the key version, never the key.

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
- At most one pending approval exists per subject, action and scope (database-enforced); an expired request
  is closed, and a job parked on it fails with `TIMEOUT` instead of waiting forever.
- A render that succeeds is not an approval.
- An agent stage that reaches a cap parks for an `agent.overrun` approval. Only a
  person can grant it; each grant allows one more run with every cap doubled, is
  consumed once by the run it authorized, and a rejection fails the stage.

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
- A harness agent stage runs with an explicit tool allowlist (every other tool is
  denied) and hard caps on turns, tokens, cost and time. A cap stop aborts the
  session and waits for the agent process to exit; a process that ignores the
  interrupt is killed, and one still alive after the grace period is reported
  `INTERNAL` rather than as a clean stop
  ([ADR-0015](decisions/0015-agent-stage-caps-and-host-handoff.md)).
- A host agent's output is untrusted input: it is validated against the stage's
  output schema before it is stored, it is accepted only for the attempt that
  handed the stage off (fenced in one transaction with the parked job), and its
  reported usage is recorded but never billed.

## Redaction

Owner: `redact()` and the logger in `packages/shared`, spans in
`packages/observability`.

- Logs, traces, errors and usage records redact credentials, `stx_` keys,
  bearer/basic headers, connector secrets and known provider key shapes.
- Agent outputs (harness and host) are redacted with `redactDeep` before they are
  stored or returned, and the task input handed to a host agent is redacted too.
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
| Agent run past its caps                                | Mid-run cap checks, abort then kill by handle, `agent.overrun` gate    |
| Forged or stale host output                            | Output schema check, attempt fencing, idempotent digest per task       |
| Job spending another user's Anthropic key              | `resolveForExecution` checks the job creator, no fallback key          |
| Expired artifact URL still valid                       | Presign expiry tests                                                   |
| Host header / origin spoofing                          | Host allow-list derived from `STUDIX_*_URL`                            |
