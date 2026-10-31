# 0011. Provider connections, credential vault and model resolution

- Status: Accepted
- Date: 2026-10-31

## Context

Agents (Pi today, the Claude Agent SDK next) need credentials for AI providers. Until now provider keys were
server environment variables (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`) used by the decision layer, and the
Pi runtime had no real loop. Users must be able to bring their own provider access, pick models, and know which
connection a job really used. Two adapters must share one credential and model system: a second key or
OAuth store per adapter would double the attack surface and the UX.

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
   usable only by their owner; repositories filter on the caller, so another member's personal connection is
   invisible, not just forbidden. A workspace connection may be used by any member's job; a personal one only by
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
8. **Job snapshot.** When a job starts, the resolved choice is stored as a `ResolvedModelSnapshot` (runtime,
   stage, source, connection id and version, provider, model, auth method, billing source, fallbacks). Retries and
   re-runs use the snapshot; changed preferences or rotated keys apply to new jobs only.
9. **Not the MCP keys.** Inbound `stx_` keys (`apikey:manage`) and outbound provider credentials share no table,
   permission or UI.

## Consequences

- One migration (`provider_connections`, `provider_credentials`, `model_preferences`) serves every adapter.
- Operators must set `STUDIX_CREDENTIAL_KEYS` before enabling connection management; without it the vault
  throws `UNAVAILABLE` and no secret is accepted.
- Losing every key that sealed a secret makes that connection unrecoverable (the user reconnects).
- New permissions `provider:connect` and `provider:manage` extend the role matrix and API key scopes.
- Delivery splits into independently mergeable parts: this domain and vault, the Pi runtime and catalog,
  the dashboard and API-key flow, then OAuth per provider.

## Alternatives considered

- **Per-runtime stores** (Pi `auth.json`, Claude CLI login): fast, but shared global state across tenants and
  duplicated UX. Rejected.
- **Env-bound secrets only** (`env:` refs as for connectors): no BYOK, no per-user credentials. Kept for
  operator connectors only.
- **KMS-envelope encryption**: stronger key custody, but needs infrastructure the deployment lacks today. The
  keyring interface leaves room to swap the key source later.
