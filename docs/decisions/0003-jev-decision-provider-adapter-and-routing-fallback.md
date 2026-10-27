# 0003. Jev DecisionProviderAdapter and routing fallback

- Status: Accepted
- Date: 2026-10-27

## Context

Jev is the decision engine for typed routing decisions (plan a video, route a
QA issue, rerank tools). It must not be bound to one vendor or transport. Two
providers are required at launch: OpenRouter and TypeSafeAI, which do not share
a wire protocol. Some decisions affect security, cost, publishing or approval
and must never be granted by accident.

## Decision

- Workflow, QA and agent runtime call only `DecisionRouter.decide(request, context)`
  in `@studix/decision-routing`. They import no provider SDK or payload type.
- `DecisionRequest`: decision type, schema and schema version, input,
  constraints, timeout, budget, trace context, optional policy id. No raw
  credentials from callers.
- `DecisionResult<T>`: validated decision, provider id, model id, usage, cost,
  latency, attempts, fallback reason, trace id, or a structured error.
- Adapters: `OpenRouterDecisionAdapter`, `TypeSafeAIDecisionAdapter`,
  `RulesDecisionAdapter`, `FakeDecisionAdapter`. Each owns its auth, endpoint,
  protocol, model mapping, error taxonomy and usage normalization. TypeSafeAI's
  real endpoint and capabilities are verified at integration time, not assumed
  OpenAI-compatible.
- `DecisionRouter` owns policy: provider selection, primary/fallback chain,
  model ids and priority from configuration per deployment or workspace. No
  silent fallback to a more expensive or less suitable provider.
- Output is validated against the schema after normalization. Bounded retries
  for network, timeout, rate limit and schema failures, within a total deadline
  and budget; retryable and terminal errors are distinguished; a bounded
  circuit breaker protects providers.
- **Rules fallback only for decision types that allow a deterministic answer**
  (for example `video.plan` falls back to the brand-intro template).
  **Security, cost, publish and approval decisions fail closed**: no valid
  decision means deny.
- Provider, model, cost, tokens, latency and fallback go to spans and activity
  logs; payloads and credentials are redacted.
- One shared contract suite runs against every adapter. CI uses fakes and
  fixtures; live provider calls run only on explicit opt-in.

## Consequences

- Swapping or adding a provider is configuration plus one adapter; MCP
  contracts, workflow state and traces do not change.
- Two adapters double the contract-test matrix; the shared suite keeps it one
  definition.

## Alternatives considered

- Keep `motion-mcp`'s split between `jev-router` and an `llm` package: two
  places own provider HTTP.
- Assume both providers speak the OpenAI protocol: unverified and fragile.
