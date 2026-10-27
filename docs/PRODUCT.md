# Product

## Vision

Studix is an AI-native video production harness. A person or an AI agent gives
a brief; Studix does the hard parts: planning, script, storyboard, asset
generation, video generation, assembly, QA, preview, feedback, approval,
publishing and the library. Users should never have to become operators of
FFmpeg, HyperFrames and twenty AI services.

**AX/UX is the first priority.** AX (agent experience) is how easily an AI
client drives Studix through `/mcp`; UX is how a human reviews, approves and
manages the same work in the dashboard.

## Audience

Marketing agencies and brands in Vietnam that need:

- high production standards and brand consistency across many videos;
- many output formats per campaign;
- several reviewers and an explicit approval step before anything is public.

Business model: usage-based billing plus on-prem/self-hosted deployments.
Pricing is not decided (see [ADR-0008](decisions/0008-billing-usage-ledger.md)).

## How people use it

1. Connect one HTTPS endpoint, `/mcp`, to an AI client (Claude, ChatGPT, an SDK
   or another agent). See [MCP_API.md](MCP_API.md#connecting-a-client).
2. Ask for a video in natural language, in Vietnamese or English.
3. The client receives a job and polls it; Studix returns progress, a preview
   URL and suggested next actions.
4. Humans watch, review and approve in the dashboard. Workspace admins add
   third-party MCP connectors there once; agents then discover permitted tools
   through tool search instead of being connected one by one.

## AX/UX principles

- **One endpoint, few tools.** A small, stable `tools/list`; capability
  discovery through `studix_inspect`; third-party tools behind search, inspect
  and execute.
- **Every response says what to do next.** Outputs carry `status`, `next[]` and,
  on failure, `error.code`, `retryable` and `suggestedAction`.
- **Async by default.** Long work returns a job immediately; nothing blocks for
  minutes.
- **References, not payloads.** Media travels as asset refs and signed URLs,
  never as binary in model context.
- **Progressive disclosure.** Schemas and guidance are fetched when needed, not
  dumped into the client context up front.
- **Errors are actionable.** A disabled connector, an exceeded budget or a
  missing approval tells the user or agent exactly which step fixes it.
- **Rendered is not approved.** A successful render is a preview until a human
  approves it under the workspace policy.

## Technical philosophy

1. **Harness owns complexity.** The client does not assemble workflows, choose
   models, call five tools to fix one issue or recover interrupted jobs.
2. **Small, intent-based MCP surface.** Typed inputs and outputs, capability
   discovery, next-action hints, structured errors, progressive disclosure.
3. **Renderer-, provider- and model-neutral core.** The video workflow is not
   tied to motion graphics, anime or a single AI provider.
4. **Deterministic first.** Validation, media transforms, scheduling, rendering
   and bookkeeping are code; AI handles creative and reasoning work. When the
   host AI already produced a spec, Studix does not pay a creative model again.
5. **Bounded agents, durable workflows.** Retries, budgets, cancellation,
   checkpoints, approval, resume, idempotency, audit and trace. Tenant isolation
   is a mechanism, not a prompt.
6. **Composable and maintainable.** Modular monolith first, durable workers
   split by workload, adapter contracts for vertical workflows, on-prem and GPU.
   No premature microservices.

## What P0 delivers

P0 is a bootstrap and one technical vertical slice. The authoritative checklist
is in [ROADMAP.md](ROADMAP.md#p0-done-means).

- Monorepo, CI on fake providers, contracts and ADRs.
- A Vietnamese brief through `/mcp` becomes a durable job, a validated
  `VideoIR`, a HyperFrames render and an MP4 in object storage, returned as a
  signed URL and playable in the dashboard.
- The P0 demo is **template motion graphics** (brand intro). It uses no AI image
  generation and no AI voice.
- Workspace API keys, tenant isolation, approval gate for publish.
- MCP-in-MCP tool search, inspect and execute against a mock third-party server.
- `DecisionRouter` with OpenRouter and TypeSafeAI adapters; live calls opt-in.
- Marketing skeleton on Cloudflare; app and worker on TOSE (dev and production); Docker
  Compose for local and self-host.

## What P0 does not deliver

- Marketing redesign or a full video editor.
- Every provider and media modality; Multix is an adapter shell with a contract.
- Pricing, checkout or credit conversion.
- GPU execution or self-hosted generation models.
- Full social publishing connectors.
- Outbound OAuth and the full connector dashboard (P1); Code Mode (P2, optional).
- Inbound OAuth for AI clients (planned, [ADR-0006](decisions/0006-auth-and-oauth-client-compatibility.md)).
- The `anime-creator` port ([issue #2](https://github.com/digitopvn/studix/issues/2)).
