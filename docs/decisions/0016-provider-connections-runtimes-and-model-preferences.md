# 0016. Provider connections per runtime and per-stage model preferences

- Status: Accepted
- Date: 2026-10-31
- Extends: [0011](0011-claude-agent-runtime-and-provider-auth.md)

## Context

ADR-0011 stores one kind of workspace credential, an Anthropic API key, and uses
it only when a job selects the Claude planner. Workspaces also want the Pi
runtime to use their own keys for other providers (OpenAI, Google, OpenRouter
and others), and to choose which model a workflow stage uses without picking it
on every job. That raises questions ADR-0011 did not answer: whether an
existing Anthropic key may now be spent by another runtime, who picks the
workspace model, and what happens to a running job when the choice changes.

## Decision

- **One vault.** Keys for every provider live in the existing
  `provider_connections` rows, sealed in-row under `STUDIX_SECRETS_KEY` with the
  same associated data as ADR-0011. There is no second secret store. A workspace
  still has at most one active connection per owner and provider.
- **Runtimes per connection.** Each connection lists the agent runtimes allowed
  to spend it (`runtimes`, `claude` and/or `pi`). Rows that existed before this
  change get `["claude"]`, so the Pi runtime cannot use an existing Anthropic
  key until someone with the right to manage that key opts in. New Anthropic
  keys default to `claude`, others to `pi`. The Claude runtime only takes
  Anthropic keys. `resolveForExecution` and `assertUsable` take the runtime and
  refuse a connection that has not enabled it (`FORBIDDEN`).
- **Version and billing.** `version` increases when the secret or the runtimes
  change. `billing_source` records how the provider bills the key; API keys are
  `usage_based`. Subscription (OAuth) logins stay out of scope for the same
  reason as in ADR-0011.
- **Model preferences.** `model_preferences` maps (scope, stage, runtime) to a
  connection and model, plus optional fallbacks (at most 3) that are used only
  when `allowFallback` is set. The most specific entry wins: the member's entry
  for the stage, the workspace entry for the stage, the member's default, then
  the workspace default (`resolveModelSelection` in `@studix/core`).
  Permissions reuse the key rules: workspace entries need `member:manage` and
  may only use workspace-owned keys; personal entries need `project:write` and
  belong to their member. Removing a connection removes the preferences that use
  it.
- **Per-job choice wins.** A job that selects a planner (`planner: {runtime:
  "claude"}`) ignores stage preferences.
- **Snapshot per job.** The first attempt of a stage pins the resolved choice
  in `job_model_snapshots` (first writer wins). Retries reuse it, so editing a
  preference never changes the model of a job that already started. The
  snapshot holds ids and the connection version, never the key.
- **Pi runtime on the same resolver.** `createPiSdkAgentRuntime` resolves its
  binding through `resolveForExecution(…, runtime: "pi")`. Each attempt opens an
  in-memory Pi session whose auth store holds only that key, with no tools, no
  discovered extensions or context files, and SDK retries and compaction off.
  Usage is reported to the bounded runtime on every assistant message, so the
  turn, cost and deadline caps of ADR-0015 stop the session while it runs.
- **Agent stages on the same choice.** Harness-mode agent stages (ADR-0015) run
  in the worker on this resolution too, keyed by the stage name, so they use
  the `default` entries unless a stage entry exists. A job that selected the
  Claude planner runs them on that connection. Otherwise the most specific
  entry of either runtime wins, Pi on a tie, and the choice is pinned per job
  and stage like the planner's. Each run records a provider execution with its
  real tokens and cost, which the stage's `agent.run` usage line links to.
- **Fallbacks.** A consented fallback is tried only for a failure at the
  provider (`PROVIDER_ERROR`, `RATE_LIMITED`, `UNAUTHENTICATED`). Caps,
  cancellation and invalid output never move to another key. A key the provider
  rejects is marked invalid. When every model fails, the stage falls back to the
  free built-in rules, and the failed spend is still billed.
- **Testing non-Anthropic keys.** Most providers have no free authenticated
  endpoint, so the test sends one short prompt to the provider's cheapest catalog
  model with a 1-cent cap. A run that stops at the cap still counts as accepted.

## Consequences

- The migration only adds columns with defaults and two new tables; existing
  keys keep working for Claude unchanged.
- Spend on a workspace's own key is recorded in the usage ledger like operator
  spend. Whether it is charged to the workspace is a billing decision outside
  this ADR.
- The Pi model catalog comes from the pinned Pi SDK version; upgrading the SDK
  can add or remove models. A preference for a removed model fails with a clear
  error and falls back to the rules.

## Alternatives considered

- **A second vault for Pi keys** (the approach in PR #37). Rejected: two key
  stores with different rotation and AAD rules for the same secret type.
- **Letting Pi use existing Anthropic keys automatically.** Rejected: it would
  spend keys under a runtime their owner never approved.
- **Resolving preferences on every attempt.** Rejected: a retry could run a
  different model, or a different account, than the first attempt.
