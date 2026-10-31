# 0011. Claude Agent SDK runtime and provider authentication

- Status: Accepted
- Date: 2026-10-31

## Context

Studix needs an `AgentRuntime` for stages that benefit from agent tool use and
creative iteration. The `@anthropic-ai/claude-agent-sdk` runs the Claude runtime
as a subprocess, so a plain `Promise.race` on abort (as in
`createBoundedAgentRuntime`) is not enough: the process could keep running and
spending. Authentication also has a policy dimension: Anthropic's
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
page (read 2026-10-31) says developers building products with the Agent SDK
should use API key authentication, that third-party developers may not offer
Claude.ai login or route requests through Free, Pro, Max or Ultra plan
credentials on behalf of users, and that they may not collect, store or
intermediate Claude.ai credentials or session tokens.

## Decision

- `createClaudeAgentRuntime` (`@studix/agent-runtime`) implements `AgentRuntime`
  over an injected `query` function. CI and unit tests use scripted queries;
  `createClaudeSdkQuery()` loads the pinned SDK lazily. No `claude` CLI parsing.
- The runtime runs only in the `worker` role. No shell or `claude -p` tool is
  exposed through the public MCP surface.
- Limits are enforced inside the run: `maxTurns` and `maxBudgetUsd` go to the
  SDK and assistant turns are counted while streaming (one turn per message id,
  since a turn can stream as several messages). The SDK checks spend after each
  turn, so the last turn can overshoot: the cap is a soft per-turn cap, and the
  actual cost is always reported, including on failures (`details`). A result
  without a cost is an error, never "free". Cost is rounded up to whole cents.
- The runtime owns the child process through `spawnClaudeCodeProcess`. Abort,
  deadline or lease loss close the SDK query and wait for the stream to end. If
  it does not end within `killGraceMs`, the process is sent SIGKILL by handle and
  the run fails with `INTERNAL` (original reason in `details`). The working
  directory is removed only once the process is confirmed gone; otherwise it is
  left for the host's reaper. Credential lookup and sandbox creation also honour
  abort and deadline.
- Zero tools: `tools: []`, `permissionMode: "dontAsk"`, and `canUseTool` denies
  everything. Custom `AgentTask.tools` are rejected with `UNAVAILABLE` until a
  scoped tool host exists. Setting sources and session persistence are off.
- Isolation per run: a fresh temp directory as `cwd` and `HOME`, removed
  afterwards, and a subprocess environment built from scratch (`PATH`, `HOME`,
  `ANTHROPIC_API_KEY`, optional base URL). Nothing is inherited from the worker.
  This is not a hard multi-tenant sandbox; production isolation (non-root user,
  network allowlist, resource limits) is a deployment requirement.
- The credential comes only from `resolveCredential(ctx, task)`. There is no
  environment fallback and no fallback between auth methods. Error messages are
  redacted of the key and of `sk-ant-` patterns.
- Provider failures map to `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED`,
  `BUDGET_EXCEEDED` or `PROVIDER_ERROR`, all non-retryable: a paid call with an
  unknown outcome is never retried automatically.
- Inbound Studix MCP credentials (`stx_` keys) and outbound Anthropic
  credentials are separate and never forwarded to each other.

- Verified against the pinned SDK (0.3.316) and its bundled runtime by
  `claude-agent-runtime.sdk.integration.test.ts`, which runs them against a
  local Messages API stand-in (no tokens spent): with every built-in tool
  removed, the model is offered only the structured-output tool (plus an inert
  placeholder) and structured output works; cancelling a hung call ends the
  process and removes the sandbox. The SDK's `num_turns` counts the
  structured-output round as a turn, so reported `turns` are model calls.

### Authentication methods

| Method                          | Decision                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic API key (usage-based) | Supported. Per-workspace or per-user BYOK, encrypted at rest, billed to the key owner.                                                                                                            |
| Claude subscription (OAuth)     | **Restricted.** Studix cloud does not collect, store or relay Claude.ai credentials. Shown as unavailable with the reason; enabling needs written approval from Anthropic for the exact use case. |
| Linked Console API credits      | An API-key path (Console key), not OAuth. Eligibility is the key owner's, checked against current Anthropic terms.                                                                                |
| Bedrock / Vertex / Foundry      | Future adapters behind the same `resolveCredential` seam.                                                                                                                                         |

Users who want to use their own subscription can run Claude Code on their own
machine and connect it to Studix as an MCP client (see `docs/MCP_API.md`).

## Consequences

- The dashboard must present the two methods as distinct and must never mark
  the OAuth method `Connected` or `Supported` without that approval.
- A later PR adds credential storage, the API-key dashboard flow, worker wiring
  and usage accounting; this ADR fixes the runtime contract they rely on.

## Alternatives considered

- Wrap `claude -p` and parse output: loses structured results, permission hooks
  and typed errors.
- Share one subscription login across tenants: prohibited by the policy above.
- Fall back from OAuth to API key on failure: can create unexpected charges.
