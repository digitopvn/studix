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

## OAuth access tokens (inbound)

Owner: `packages/auth` (`mcp-oauth*.ts`), `apps/mcp-server/src/api/oauth-routes.ts`.

- The authorization server is the dashboard's Better Auth instance, not the
  dashboard login itself: it owns separate clients, consents and tokens, and
  reuses the dashboard sign-in as one step.
- Authorization code + PKCE `S256` only, exact redirect URI match, signed
  authorization query, 120 second single-use codes, hashed client secrets,
  codes and refresh tokens. Dynamic clients are public PKCE clients.
- Access tokens are JWTs (10 minutes) with `iss`, `aud` = the `/mcp` resource
  (RFC 8707), `azp` and `workspace_id`. Only `EdDSA`, `ES256` and `RS256` are
  accepted. A token without a resource is opaque and refused.
- Every request re-checks membership of the workspace, a live consent for the
  client and a non-disabled client, so removing a member or revoking a
  connection from the dashboard takes effect on the next request (a token
  minted before the current consent is refused, so reconnecting does not revive
  it). A client revoking its own token through RFC 7009 only stops the refresh
  token; the access token lives out its 10 minutes. Permissions are the
  intersection of token scope, consent and the user's current role. OAuth
  actors never hold approval, publish, API-key, member or operator permissions.
- Tokens are never forwarded to connectors, providers or storage. Logs and
  error bodies carry no token, code or secret; a rejected token gets one
  generic `invalid_token` answer without saying why.
- Public CORS (any origin, no credentials) applies only to the discovery
  documents and the token, registration and revocation endpoints; everything
  under `/api` otherwise keeps the Origin guard.
- Details and verification status:
  [ADR-0006](decisions/0006-auth-and-oauth-client-compatibility.md).

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

### Platform credentials (operator)

Media vendor keys that the Multix CLI uses can be stored from **Storage &
Media**. They are sealed with the same master key as workspace provider keys
(AES-256-GCM, bound to the name `platform:<NAME>`, so a ciphertext copied under
another name does not open). Rules:

- Only a signed-in dashboard session of a user with the `operator` role may read
  the overview, store, rotate, revoke or test. Owners, admins, API keys, OAuth
  clients (agents) and the system actor get `FORBIDDEN`; there is no MCP tool
  that reads or writes these keys.
- A key travels in a request body once. Responses, audit events and logs carry
  a hint (last four characters), the version and who changed it, never the
  value; the value is also registered for log redaction.
- Only names on a fixed allowlist are accepted, so this is not an environment
  editor. The Multix child receives only allowlisted vendor names from the
  store (`PATH`, `LD_PRELOAD` and the like are ignored) and runs with
  `MULTIX_DISABLE_HOME_ENV=1`.
- The R2 key pair may be stored the same way (as `S3_ACCESS_KEY_ID` and
  `S3_SECRET_ACCESS_KEY`) and is never shown again. It is never handed to the
  Multix child, which only receives vendor key names.
- Every change is audited (`platform_credential.created`, `rotated`, `revoked`,
  `tested`) in the operator's workspace, or in `STUDIX_PLATFORM_WORKSPACE_ID`
  when it is set. The R2 key pair is stored the same way, and only after a
  write/read/delete probe with it passes.

### Storage profiles (operator and workspace)

An operator can point new objects at another S3-compatible bucket
([ADR-0020](decisions/0020-storage-profiles.md)). The server connects to that
endpoint with stored credentials, so these rules apply:

- **Who:** platform profiles: only the `operator` role on a dashboard session.
  A workspace's own profiles ([ADR-0023](decisions/0023-workspace-storage-profiles.md)):
  its owners and admins on a dashboard session. Everyone else gets `FORBIDDEN`:
  editors, viewers, API keys, OAuth clients and the system actor. A profile from
  another scope reads as `NOT_FOUND`, and the router never uses a workspace's
  profile for another workspace. There is no MCP tool for it.
- **Probe first:** a profile is stored only after a write/read/head/delete probe
  with the candidate settings passes.
- **Sealed keys:** the key pair is sealed with `STUDIX_SECRETS_KEY` and bound to
  `storage-profile:<id>:access|secret`. Views, errors, audit events and logs
  carry only a last-four hint.
- **Audit:** `storage_profile.created`, `updated`, `activated`, `revoked` and
  `tested` are audited without secrets, in the platform workspace for platform
  profiles and in the workspace itself for its own.
- **SSRF guard** (`packages/storage/src/endpoint-guard.ts`):
  - HTTPS only.
  - No credentials, path or query in the URL.
  - No IP literals, `localhost`, `.internal`, `.local` or `.localdomain` hosts.
  - R2 endpoints must end in `.r2.cloudflarestorage.com`.
  - Every address the host resolves to must be public. This is checked at save
    time, and again on each connection through the socket `lookup` of the S3
    client, so a DNS answer that changes after the check (rebinding) is still
    refused.
  - Link-local and cloud metadata addresses (`169.254.0.0/16`,
    `100.100.100.200`, `fd00:ec2::254`) are always blocked.
  - Private and loopback ranges are allowed only with
    `STUDIX_STORAGE_ALLOW_LOCAL_ENDPOINTS` (local development).
  - The S3 SDK does not follow redirects.
- **Media CSP:** the dashboard CSP media origins follow the configured profiles.

### Workspace media keys (BYOK)

A workspace admin may store the workspace's own key for a Multix vendor under
**AI & Providers → Media vendor keys**. Rules:

- Stored as a `provider_connections` row (`provider: media-<vendor>`, owner
  `workspace`), sealed like other provider keys and bound to the organization,
  workspace and row id. The row has no agent runtime, and the generic
  connection calls refuse it, so Claude or Pi can never be handed a media key.
- The worker reads the keys of the job's own workspace only, right before each
  media generate or resume, and layers them over the platform keys for that
  call. The shared `multix check` capability probe never sees them.
- Spend on a workspace key is recorded with `funding: "workspace"` on the
  provider execution and the usage line: recorded, not charged (ADR-0016). A
  call whose vendor has no workspace key keeps the platform key and funding.
- Removing a key revokes the row in Studix, not at the vendor.
- Audit events: `provider_connection.created`, `rotated`, `revoked`, in the
  workspace that owns the key.

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
  - An AI client connected through OAuth acts for its user, so it can run that
    user's personal keys and defaults, but only a signed-in user can add, change
    or remove them.
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

Keys for other providers (OpenAI, Google, OpenRouter, OpenCode Go and others) use the same
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
  the resolved key. The allowed providers are listed in
  `packages/agent-runtime/src/pi-catalog.ts`; OpenCode Go (`opencode-go`) uses
  the endpoint and model prices pinned by the Pi SDK, never `OPENCODE_API_KEY`
  from the server environment. It has no tools, reads no `~/.pi` files, settings,
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

## Imported GitHub skills

Skills imported from public GitHub repositories are untrusted third-party text
([ADR-0017](decisions/0017-external-github-skill-store.md),
[EXTERNAL_SKILLS.md](EXTERNAL_SKILLS.md)).

- Egress is fixed to `api.github.com` and `raw.githubusercontent.com`. The
  user's URL is only parsed, never requested, so it cannot reach internal hosts;
  redirects are handled manually inside the allowlist.
- Every regular file is stored, scripts and binaries included, so the skill
  sandbox ([ADR-0018](decisions/0018-skill-sandbox.md)) can run them; the server
  and worker host never execute or install anything from a skill. Symlinks and
  submodules are skipped, unsafe paths dropped, and every read is byte-capped
  with timeouts.
- Zip uploads are never fetched from a user URL: small archives arrive inline,
  larger ones through a presigned PUT into Studix's own bucket that is read once
  and deleted. The reader rejects absolute paths, `..`, drive letters, control
  characters, duplicate paths, ZIP64 and encryption, skips symlinks, and stops
  zip bombs with entry, size and compression-ratio limits and capped inflation.
- Each version gets a risk report (`low`/`medium`/`high`). A high-risk first
  version starts disabled; enabling or activating a high-risk version needs
  `confirmHighRisk` from a user with the admin, owner or operator role (never an
  API key) and is audited with the level and version. The scanner is a review
  aid, not a filter.
- Platform-scope skills ([ADR-0019](decisions/0019-full-skill-store-uploads-and-risk-gate.md))
  are visible to every workspace and writable only by platform operators.
- Versions are pinned to a commit, content-hashed and immutable; the hash is
  rechecked on read. An upstream change is never served until activated.
- `studix_skill_get` marks content untrusted and lists heuristic
  `securityNotes`; the prompt-injection rule above applies to it.
- `STUDIX_GITHUB_TOKEN` is optional, sent to `api.github.com` only and redacted.

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
- A harness stage that asks for shell or file tools runs them in a per-task
  Docker container, never on the worker: read-only root, no capabilities, uid
  1000, CPU/memory/PID/wall-time caps, its own `/work`, the enabled skills
  read-only at `/skills`. Its environment holds only that task's media vendor
  keys, passed by name; database, storage, secrets-box and model keys never enter
  it. Without `STUDIX_SANDBOX=docker` such a stage fails `VALIDATION`
  ([ADR-0018](decisions/0018-skill-sandbox.md)).
- On TOSE (`STUDIX_SANDBOX=sidecar`, [ADR-0025](decisions/0025-sidecar-skill-runner.md)) the same tools run in
  a `pi-runner` sidecar of the worker's pod instead. The runner holds no database or storage secret, no
  worker-held model key and no Kubernetes token, only the task's media vendor keys passed per session and its own
  bearer token (32 characters or more, one per runner). As on Docker, a task that runs the `codex` or `claude` CLI
  in the sandbox has its own model credential written under `/work` for that CLI, wiped when the session closes. Containers of a pod share a network namespace, so skill code in a session can reach
  the internet and the worker's loopback ports; the token, not `127.0.0.1`, is the authorization for a runner.
  This is not strong isolation between hostile tenants, so the backend is gated to workspaces listed in
  `STUDIX_SANDBOX_SIDECAR_WORKSPACES` (any other workspace gets `FORBIDDEN`) and is meant for trusted or
  internal use. Setting it to `*` opens the runners to every workspace; the operator then accepts these risks for
  all tenants, and the worker logs `skill runners open to every workspace` at startup. Residual risks: shared kernel, open egress, processes of one session sharing a uid, and the Pod-wide
  `/dev/shm` and IPC namespace, which the runners cannot wipe without deleting another runner's live files.
  TOSE drops all capabilities, forces non-root, the default seccomp profile and `allowPrivilegeEscalation: false`
  (so the image's setuid binaries such as `su` cannot gain privileges), and mounts no service account token.
  `studix_media_exec` is refused on this backend because it needs an offline sandbox.
- A ChatGPT sign-in for Codex uses the device-code flow: the browser talks to
  OpenAI, Studix only holds a sealed, 15-minute flow token bound to the user and
  workspace that started it. The resulting tokens are stored sealed like an API
  key and never returned. For a Codex run the worker writes `auth.json` into the
  task sandbox's scratch `CODEX_HOME` through stdin (an API key goes through
  `codex login --with-api-key` on stdin), never on a command line; the file is
  read back after the run to keep a rotated refresh token, and the container is
  removed with it. A ChatGPT connection runs only on the `codex` runtime.
- A Claude agent's tool-using stage runs Claude Code in the same sandbox. Its
  API key or subscription token is written through stdin to a scratch file
  that the launching shell reads into the process environment and deletes;
  it never appears on a command line, and the agent's tools reach only the
  container.
- A host agent's output is untrusted input: it is validated against the stage's
  output schema before it is stored, it is accepted only for the attempt that
  handed the stage off (fenced in one transaction with the parked job), and its
  reported usage is recorded but never billed.

## Media exec

`studix_media_exec` passes caller-chosen ffmpeg/ffprobe arguments to a real
binary, so the arguments are untrusted. Owner: `packages/core/src/studio/media-exec.ts`
(validation), `apps/worker/src/media-exec-runner.ts` (execution).

- Each job runs in its own Docker sandbox container: `--network none`, read-only
  root, no capabilities, uid 1000, CPU/memory/PID/wall-time caps, an empty
  environment and its own scratch `/work`, removed after the run.
- argv is passed without a shell; the worker quotes every word. Placeholders map
  only to `/work/in` and `/work/out`; absolute, Windows, home and `..` paths,
  URLs and protocol prefixes are refused, and `-protocol_whitelist file,pipe` is
  forced before every input, so ffmpeg cannot open network or other protocols
  even through filters or concat lists (`-safe` and protocol options are refused).
- URL inputs are fetched by the worker, not the sandbox: https only, internal
  hosts and private/reserved IPs refused, DNS pinned by the guarded lookup, each
  redirect re-checked, size capped.
- Output size is capped with `ulimit -f` and checked again before upload; logs
  and JSON are truncated. Asset inputs are read only within the caller's workspace.
- The `media.exec_started` audit event records tool, argument count, input names
  and source types, output names and timeout, never argument text or input
  contents. Compute time is metered into the job budget, failed runs included.

## Redaction

Owner: `redact()` and the logger in `packages/shared`, spans in
`packages/observability`.

- Logs, traces, errors and usage records redact credentials, `stx_` keys,
  bearer/basic headers, connector secrets and known provider key shapes.
- Agent outputs (harness and host) are redacted with `redactDeep` before they are
  stored or returned, and the task input handed to a host agent is redacted too.
- Raw prompts and downstream payloads are not logged by default; traces record
  provider, model, latency, tokens, cost, bytes and outcome.

## Render capture isolation

A HyperFrames capture runs page JavaScript in headless Chrome on the worker, and
the producer reads the media that the live DOM names. Studix patches HyperFrames
so that a capture cannot reach anything outside its project
([RENDERER.md](RENDERER.md#hyperframes-version)):

- The browser sends every non-loopback request, WebSockets and WebRTC included,
  to a proxy that cannot resolve. Nothing falls back to a direct connection, and
  DNS lookups fail for every host except `localhost`.
- Request interception aborts every page request whose origin is not the
  producer's file server, including other loopback ports and navigations.
  Popup blocking stays on, and popups are closed.
- Runtime media must be a file-server URL or a relative path inside the project.
  The producer drops every other value before it downloads or reads anything on
  the host.

Residual risk: requests from a dedicated worker to another loopback port pass
only through request interception, and the render process itself has no egress
policy. Its own downloads are limited to authored HTTPS media, which Studix
compositions do not use. A network policy on the worker pod that denies egress
except to its database, storage and providers closes the remaining gap.

## Threat list

Each item maps to a negative test in the owning package.

| Threat                                                   | Control                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Cross-tenant read/write                                  | `TenantContext` in every repository call; tenant A/B tests                                                 |
| Stolen or leaked API key                                 | Hashed storage, revocation, scopes, redaction                                                              |
| OAuth token replayed to another resource or workspace    | `aud`/`iss` check, `workspace_id` claim, membership and consent recheck                                    |
| Revoked OAuth grant still usable                         | Consent row required on every request, tokens revoked with it                                              |
| Inbound credential forwarded downstream                  | Separate outbound credentials via `secretRef`                                                              |
| `secretRef` value leak                                   | Resolution only at execute, never serialized                                                               |
| SSRF to internal or metadata IPs                         | URL policy, IP range denylist                                                                              |
| DNS rebinding                                            | Pinned resolution                                                                                          |
| Redirect to internal host or wrong origin                | Manual redirect handling, origin-bound credentials                                                         |
| Malicious tool description / result (prompt injection)   | Data-not-instruction rule, bounded summaries, code-side authorization                                      |
| Permission changed after search                          | Re-authorization at execute                                                                                |
| Disabled or revoked tool still callable                  | Catalog invalidation and execute-time check                                                                |
| Recursion through Studix's own `/mcp`                    | Self-reference rejection                                                                                   |
| Oversized result or schema                               | Size caps, truncation, asset refs                                                                          |
| Duplicate side effects on retry                          | Idempotency keys, no auto-retry of unknown-outcome mutations                                               |
| Duplicate billing on retry                               | Usage dedupe keys ([ADR-0008](decisions/0008-billing-usage-ledger.md))                                     |
| Publish or high-cost action without approval             | `ApprovalPolicy`, fail closed                                                                              |
| Runaway cost                                             | Budgets checked before each costly stage                                                                   |
| Agent escaping its workspace                             | Worker pod isolation, no shell, scoped credentials                                                         |
| Agent run past its caps                                  | Mid-run cap checks, abort then kill by handle, `agent.overrun` gate                                        |
| Forged or stale host output                              | Output schema check, attempt fencing, idempotent digest per task                                           |
| Job spending another user's Anthropic key                | `resolveForExecution` checks the job creator, no fallback key                                              |
| SSRF or path escape through a skill import               | Fixed GitHub hosts, parsed-only URL, safe-path filter, symlink skip                                        |
| Imported skill text steering the agent or running code   | Untrusted marker, risk report, audited high-risk confirmation, sandbox-only execution, explicit activation |
| Zip slip or zip bomb in a skill upload                   | Path checks reject the archive, symlinks skipped, entry/size/ratio caps, capped inflation                  |
| Expired artifact URL still valid                         | Presign expiry tests                                                                                       |
| Host header / origin spoofing                            | Host allow-list derived from `STUDIX_*_URL`                                                                |
| Argument injection or file/network access through ffmpeg | Shell-free argv, path and protocol checks, forced `-protocol_whitelist`, offline per-job sandbox           |
| Capture page script reaching the network or host files   | Dead-proxy launch flags, file-server-only request interception, project-only runtime media                 |
