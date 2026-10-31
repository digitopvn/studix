# 0011. Claude Agent SDK runtime and provider authentication

- Status: Accepted (runtime contract); subscription OAuth is gated, see below
- Date: 2026-10-31

## Context

Studix plans with the `DecisionRouter` today. Some stages need an agent loop with
tool use. The Claude Agent SDK runs Claude as a subprocess, so it must live in the
worker, behind the existing `AgentRuntime` port, with hard limits that the
`Promise.race` based `BoundedAgentRuntime` cannot give: aborting a promise does
not stop the process, and turn/cost limits checked after the run do not cap spend.

## Decision

- `createClaudeAgentRuntime` (`@studix/agent-runtime`) implements `AgentRuntime`
  on top of a `ClaudeAgentTransport` seam. CI uses `createFakeClaudeTransport`; the worker
  injects `createClaudeSdkTransport`, the adapter over
  `@anthropic-ai/claude-agent-sdk` (exact version in `package.json`, installed into
  the image from the frozen lockfile).
- Each SDK session gets a throwaway working directory that is also its `HOME`, an
  environment built from scratch (`PATH`, the session key, auto-update and
  non-essential traffic off), no settings files, no persisted session and no
  built-in tools (`tools: []`). The adapter spawns the Claude process itself, so
  `kill()` reaches it by handle, and `closed` settles only after that process has
  exited and the directory is removed. A stop that lands before the SDK spawns
  refuses the spawn.
- Turns are counted as model calls (distinct assistant message ids). The SDK's
  `num_turns` counts the structured-output round as an extra turn, so a one-call
  plan reports 2 and would trip `maxTurns: 1`.
- Only failures that come from Anthropic (an `API Error: NNN` status or an
  Anthropic error type) are provider errors and are not retried. A failure on the
  worker's side (SDK import, spawn, process crash or OOM kill) is `UNAVAILABLE`
  and retryable, with the raw text only in redacted `details`.
- Limits are enforced **while the session runs**: turns and cost stop the process
  as soon as a usage event crosses the cap; the SDK's own `maxTurns` and
  `maxBudgetUsd` are passed as a second layer.
- Abort, lost lease and deadline call `interrupt()`, then `kill()` after a grace
  period. `run` settles only after the process has closed, so a job never reports
  cancelled while its subprocess still runs. Once stopping, `canUseTool` denies
  every call: zero tool execution after lease loss.
- Tools are deny-by-default: only names declared in `AgentTask.tools` are allowed.
  No `bypassPermissions`, no shell tool, nothing exposed through public MCP.
- The credential is resolved per tenant by a `ClaudeCredentialResolver`, handed
  to the session only, and upstream errors are mapped (401 `UNAUTHENTICATED`,
  403 `FORBIDDEN`, 429 `RATE_LIMITED`) with keys redacted. There is never an
  automatic fallback between authentication methods.
- Output is validated by an injected validator (VideoIR for the planner); the
  agent's output is never trusted.
- Runtime selection is per job and opt-in: `planner: {runtime: "claude",
  providerConnectionId}` on `studix_create_video` or the dashboard form, honoured
  only when the operator sets `STUDIX_CLAUDE_PLANNER=true`. `core` depends on no
  vendor; it stores the selection and the worker routes it.

## Authentication methods

| Method                                      | Status                                                                         | Billing                                |
| ------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------- |
| Anthropic API key (BYOK or workspace-owned) | Build first (PR 2)                                                             | Usage-based, on the key's organization |
| Claude subscription (OAuth)                 | **Not enabled.** Dashboard shows "Restricted — not available for Studix cloud" | Subscription limits                    |

Anthropic's Legal and compliance page and the Agent SDK overview restrict third
parties from offering Claude.ai login or relaying Free/Pro/Max credentials in their
own product without approval. The Help Center article on using the SDK with a plan
does not authorise a multi-tenant SaaS to collect or relay OAuth tokens. Until
Anthropic confirms this use case in writing, Studix will not ship a Connect
button, store consumer tokens, or mark the method Connected or Supported. Users
who want subscription usage can run Claude Code on their own machine and connect
it to Studix as an MCP client. Monthly API credits on some plans apply to Console
API keys, so they belong to the API-key path.

Studix inbound MCP credentials (`stx_` keys) stay separate from Anthropic outbound
credentials and are never forwarded.

## Consequences

- The runtime is testable without tokens or the SDK installed.
- PR 2 added encrypted credential storage, the API-key dashboard flow and the
  restricted OAuth card. PR 3 wired the worker planner, provider execution and
  usage records, and an E2E run with the fake transport. A live run needs a real
  key and is opt-in.
- The agent gets no tools in the planner today. A Studix tool for the agent
  would need an in-process MCP server and is out of scope.
- A run that fails after the agent reported usage (cost cap, turn limit,
  invalid output, process crash) carries that spend on its error. The planner
  records it on the provider execution and in the job's usage ledger, and the
  error is not retryable: each retry would spend on the tenant's key again. A
  failure before any usage (credential lookup, SDK import) stays retryable:
  those faults are local and usually transient, and a retry costs nothing.
  A host that can never run the Claude process is caught earlier: the worker
  runs a startup preflight (`preflightClaudeRuntime`) and refuses to start.
- A 401 from Anthropic during a run marks the connection `invalid`
  (`reportKeyRejected`), so `assertUsable` stops accepting the key. The mark is
  skipped when the key was rotated after the run began.
- The OAuth flow is a separate, compliance-gated PR and is not part of "done" for
  the API-key path.

## Alternatives considered

- Wrap `claude -p` output: loses permission hooks, structured output and streaming usage.
- Reuse `createBoundedAgentRuntime`: cannot guarantee the subprocess stops or cap cost mid-run.
- Run the agent in `apps/mcp-server`: puts a subprocess on the request path and widens the public surface.
