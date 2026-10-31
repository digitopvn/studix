# 0011. Provider connections, credentials and model resolution

- Status: Accepted
- Date: 2026-10-31

## Context

Studix needs outbound AI provider authentication for more than one execution
adapter: the Pi SDK runtime and the Claude Agent SDK runtime. Both must share one
data model, one encrypted credential store, one Dashboard settings area and one
audit trail. Two parallel key/OAuth systems would drift and double the security
surface. Inbound Studix MCP authentication (`stx_` keys, dashboard sessions) is a
different concern and stays separate.

## Decision

- **ProviderConnection** (`@studix/core`) is the single record for an outbound
  credential binding: `providerId`, `authMethod` (`api_key`,
  `oauth_subscription`, `custom_endpoint`), owner (`user` or `workspace`),
  `status`, `billingSource`, `runtimes` allowed to use it, and an opaque
  `secretRef`. The record holds metadata only.
- **Provider vs runtime.** A provider (Anthropic) is a catalog entry; a runtime
  (`pi`, `claude-agent-sdk`) declares which providers and auth methods it can
  execute. One connection can serve several runtimes only if its `runtimes`
  list says so.
- **CredentialStore** port: `put`, `replace`, `resolve`, `delete`, all
  tenant-scoped, encrypted at rest. `resolve` is called by the worker at
  execution time only. API handlers, the Dashboard, MCP responses, traces and job
  output never receive plaintext. The existing env-bound connector secret
  resolver is a different, operator-managed path and is not reused for user
  credentials.
- **Status vocabulary** is fixed: `not_connected`, `connecting`, `connected`,
  `invalid`, `expired`, `restricted`, `revoked`, `requires_action`,
  `unsupported`. Only `connected` and unexpired is usable. `restricted` is
  shown with a reason and never enables a login button.
- **Billing source** is explicit: `subscription`, `extra-usage`, `usage-based`,
  `unknown`. `unknown` is displayed as unknown, never as free.
- **Ownership.** User-owned connections are usable only by that user.
  Workspace-owned connections are managed by admins (`provider:manage`) and
  usable by members they are granted to. Members never read another principal's
  secret.
- **OAuth compliance gate.** Subscription OAuth for a provider is enabled only
  with a recorded legal basis. Until then the connection is `restricted`.
  Claude Pro/Max OAuth is restricted by default; Anthropic third-party harness
  usage can bill extra usage and does not imply subscription quota. Pi's
  upstream support for a provider is not evidence that Studix may offer it.
- **Model resolution** (`resolveModelSelection`): preferences have scope
  stage > workflow > user > workspace. The resolver takes the single most
  specific applicable preference and tries its primary, then only its listed
  fallbacks, in order. It never falls through to a less specific preference,
  never picks a connection the preference did not name, and verifies provider,
  runtime, owner, status, expiry and catalog availability. A fallback is an
  explicit consented choice; there is no automatic switch to another credential.
- **Job snapshot.** Each job stores a `ResolvedModelSnapshot` (runtime,
  provider, model, connection id, auth method, billing source, source level,
  fallback flag). A rerun reuses it instead of resolving again, so a retry never
  silently changes model, provider or credential.
- **Pi isolation.** Studix never reads or writes a shared `~/.pi/agent/auth.json`.
  The Pi runtime receives an explicit model and in-memory credentials per job and
  does not inherit server `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY`.

## Consequences

- The Pi runtime, Claude Agent SDK runtime and Dashboard build on the same
  types, so they can ship as independent PRs.
- Persistence (tables, encryption, migration) and the Dashboard/API are separate
  follow-up changes; this record fixes the contract they implement.
- Adding a provider or auth method is a catalog change plus a compliance entry,
  not a schema change.

## Alternatives considered

- Per-runtime credential tables: simplest per adapter, but duplicates rotation,
  audit and RBAC and invites a second OAuth system.
- Reusing Pi's local credential store: shares state across tenants.
- Automatic fallback across any usable connection: hides spend and violates the
  consent requirement.
