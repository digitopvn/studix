# 0012. Provider connections, credential vault and model resolution

- Status: Accepted
- Date: 2026-10-31

## Context

Agents (Pi today, the Claude Agent SDK next) need credentials for AI providers. Until now provider keys were
server environment variables (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`) used by the decision layer, and the
Pi runtime had no real loop. Users must be able to bring their own provider access, pick models, and know which
connection a job really used. Two adapters must share one credential and model system: a second key or
OAuth store per adapter would double the attack surface and the UX. The Claude Agent SDK runtime contract
([ADR 0011](0011-claude-agent-runtime-and-provider-auth.md)) expects its encrypted credential storage and API-key
flow from this shared domain, and its subscription OAuth gate applies here unchanged.

Pi stores credentials in `~/.pi/agent/auth.json` by default and falls back to environment variables. On a
multi-tenant worker both are wrong: the file is shared by every tenant and the environment belongs to the
operator.

## Decision

1. **One domain, adapter-neutral.** A `ProviderConnection` (`@studix/core`) is metadata: provider id, label,
   `authMethod` (`api_key` | `oauth`), owner (`workspace` or one `user`), `status`, `billingSource`, the runtimes it
   may be used with, an opaque `secretRef`, a display `keyHint` and a `version`. Runtimes declare which
   providers and auth methods they support; connections never belong to a runtime.
2. **Credential vault.** Secrets live only in `provider_credentials`, sealed with AES-256-GCM. The
   authenticated data binds ciphertext to `workspaceId` and `secretRef`, so a copied row never opens in another
   tenant. Keys come from `STUDIX_CREDENTIAL_KEYS` (`id:base64`, first entry active, older ones kept to read
   existing secrets, which makes rotation a config change plus re-seal). The vault is the only code that
   decrypts, at execution time, and it registers the value with the log redactor. A connection record,
   list response, trace, MCP result or job output never carries a secret; `toPublicConnection` drops
   `secretRef`.
3. **Ownership and visibility.** Workspace-owned connections are created by holders of `provider:manage`
   (owner, admin). Personal connections need `provider:connect` (editor and up) and are visible and
   usable only by their owner; repositories filter reads on the caller, so another member's personal connection is
   invisible, not just forbidden, and refuse to create a personal connection or preference for any user
   other than the calling user. A preference may only point at connections visible to the caller; a workspace
   preference may only point at workspace-owned ones. A workspace connection may be used by any member's job; a personal one only by
   its owner's jobs.
4. **Status and cost honesty.** Only `connected` connections are handed to a runtime. `billingSource` is
   never assumed: API keys are `usage-based`; OAuth connections start `unknown` and are shown as `extra-usage` or
   `subscription` only with evidence for that provider. Providers that do not allow third-party OAuth in a
   hosted product are `restricted` with an explanation and no working login button.
5. **Auth modes.** API key is the production path. OAuth is added per provider only after its terms allow a
   multi-tenant web service (Anthropic Claude Pro/Max OAuth stays gated, see issue #32). OAuth is driven through the
   SDK's programmatic login with server-side state, PKCE where the provider supports it, never by driving a TTY
   or `pi /login`.
6. **No shared auth store.** Pi sessions get an in-memory auth store populated with exactly the one
   decrypted credential of the resolved connection, an in-memory model registry and an in-memory session manager.
   Nothing reads or writes `~/.pi/agent`, and the server environment is not inherited as a credential source.
7. **Model resolution.** `ModelPreference` rows are keyed by (scope owner, stage, runtime) where scope is
   workspace or user. Precedence, most specific first: user + stage, workspace + stage, user default, workspace
   default (`resolveModelSelection`, pure). No match is an error, never a guess. Fallbacks are only used when the
   preference sets `allowFallback`, and each fallback names its own connection, so a failure never
   changes credential silently.
8. **Job snapshot.** The first time a job resolves a model for a stage, the choice is stored as a
   `ResolvedModelSnapshot` (runtime, stage, source, connection id and version, provider, model, auth method, billing
   source, fallbacks) in `job_model_snapshots`, one row per (job, runtime, stage); the first write wins. A retry keeps the
   snapshot's connection and model and reads that connection's current secret, so a rotated key keeps working;
   a changed preference never applies to an existing job.
9. **Not the MCP keys.** Inbound `stx_` keys (`apikey:manage`) and outbound provider credentials share no table,
   permission or UI: default API key scopes never include `provider:*`.
10. **Where the workspace model runs.** The worker maps decision kinds to stages (`video.brief` → `plan`). When the
    workspace or the job's creator chose a Pi model for that stage, the decision runs on it with that connection's key.
    Without a choice the operator's decision router runs exactly as before; "no choice" means no preference
    matched, never an error that merely looks similar. When the workspace model fails (rejected key, a stored key
    that no longer opens, outage, invalid answer, no budget left) the job continues on the free rules provider; it
    never moves onto credentials the operator pays for. Spend of a failed run is kept in the result. Inside one
    attempt, a provider failure (including a rejected key) moves to the next fallback only when the preference
    allowed fallbacks; budget caps, cancellation and invalid output never do. When two attempts of one job resolve
    at once, both run the snapshot that was pinned first.
11. **No custom endpoints yet.** `baseUrl` is not accepted from users. A user-supplied endpoint would let a tenant make
    the server call private addresses; it waits for the outbound URL policy that already guards MCP connectors.
    Providers whose SDK path reads ambient credentials (cloud IAM, ADC, account ids from the environment) are not
    offered at all.
12. **Dashboard and API.** Settings > AI & Models (`/api/providers`) lists the Pi catalog, creates API-key
    connections, tests them with one tiny prompt capped at one cent (cheapest catalog model unless one is named),
    rotates and deletes them, saves per-stage preferences and previews the model each stage resolves to for the
    caller. Keys are write-only; responses carry the hint and `Cache-Control: no-store`. Without a credential keyring
    the API answers `UNAVAILABLE`. A test changes the status only on proof: a working key marks it `connected`, a
    rejected one `invalid`; a timeout, rate limit or outage leaves it as it was, and a key replaced while the test
    ran keeps the status the replacement set.

## Consequences

- One migration (`provider_connections`, `provider_credentials`, `model_preferences`, `job_model_snapshots`) serves
  every adapter.
- Operators must set `STUDIX_CREDENTIAL_KEYS` before enabling connection management; without it the vault
  throws `UNAVAILABLE` and no secret is accepted. The app (to seal) and the worker (to open) need the same keyring;
  a worker without it ignores workspace models and keeps the operator router.
- Losing every key that sealed a secret makes that connection unrecoverable (the user reconnects).
- New permissions `provider:connect` and `provider:manage` extend the role matrix for users only; inbound API keys do not derive them.
- Open product questions: spend on a workspace's own key is recorded in the usage ledger like operator spend
  (`billingSource` on the snapshot tells them apart, but invoices do not yet); nothing yet removes a personal
  connection when its owner leaves the workspace.
- Delivery splits into independently mergeable parts: this domain and vault, the Pi runtime and catalog,
  the dashboard and API-key flow, then OAuth per provider.

## Alternatives considered

- **Per-runtime stores** (Pi `auth.json`, Claude CLI login): fast, but shared global state across tenants and
  duplicated UX. Rejected.
- **Env-bound secrets only** (`env:` refs as for connectors): no BYOK, no per-user credentials. Kept for
  operator connectors only.
- **KMS-envelope encryption**: stronger key custody, but needs infrastructure the deployment lacks today. The
  keyring interface leaves room to swap the key source later.
