# Porting manifest

Studix ports selectively from `motion-mcp` and refactors deliberately. This
manifest records the source, the license obligations and where each source
package went.

## Source

| Field | Value |
|---|---|
| Repository | [digitopvn/motion-mcp](https://github.com/digitopvn/motion-mcp) |
| Pinned commit | `408ceccd6e2fb5888384e8a4bb7c7385ad1dafda` |
| License | MIT, Copyright (c) 2026 Digitop |

Attribution: code copied or adapted from `motion-mcp` keeps the MIT notice. The
source copyright holder is Digitop, the same owner as Studix. Any file ported
substantially intact should name the source path and SHA in its header comment
so the provenance survives refactors.

## Actions

- **Ported**: logic carried over with renames and rebranding only.
- **Generalized**: the idea and parts of the code kept, reshaped for a
  renderer/provider-neutral, multi-tenant harness.
- **Replaced**: the source implementation is not production-ready for Studix;
  a new implementation fills the same role.
- **Not yet ported**: intentionally left behind for P0.

Status of each row is the state of the P0 target; the code is the evidence once
merged.

## Mapping

| Source (`motion-mcp`) | Studix target | Action | Notes |
|---|---|---|---|
| Monorepo layout, pnpm/TS/Biome/Vitest conventions | Root tooling, `@studix/*` scope | Ported | `./src/index.ts` exports, `tsx` for apps ([ADR-0001](decisions/0001-monorepo-and-package-boundaries.md)) |
| `apps/mcp-server` | `apps/mcp-server` | Generalized | `motion_*` tools become the smaller `studix_*` surface plus MCP-in-MCP meta-tools; static bearer keys replaced by hashed workspace keys |
| `apps/dashboard` | `apps/dashboard` | Generalized | GitHub OAuth sign-in replaced by Better Auth email/password; P0 views only |
| `apps/marketing` | `apps/marketing` | Ported | Skeleton only, rebranded; no design work in P0 |
| (planned `apps/render-worker`) | `apps/worker` | Replaced | Real worker role over the Postgres queue |
| `packages/shared` | `@studix/shared` | Ported | Config (env only, Studix hostnames), logger, redaction, ids; error model becomes `StudixError` + `ErrorCode` |
| `packages/motion-ir` | `@studix/video-ir` | Generalized | `MotionIR`/`CreativeSpec`/`ScenePatch` ideas become `VideoIR`/`Scene`/`Shot`/`Timeline`/`AssetRef`; motion is one specialization ([ADR-0002](decisions/0002-video-ir-and-domain-contracts.md)) |
| `packages/pipeline` (runtime, jobs, build loop) | `@studix/workflow` + `@studix/core` `StudioService` | Generalized | Typed stages and templates; tool schemas move to the MCP app and `video-ir` |
| `packages/pipeline` in-process job queue | `@studix/workflow` Postgres queue | Replaced | [ADR-0005](decisions/0005-durable-jobs-on-postgres.md) |
| `packages/pipeline` search | deferred `search` package | Not yet ported | P1 |
| `packages/hyperframes-adapter` | `@studix/renderers` (HyperFrames) | Ported | Behind `RendererAdapter` ([ADR-0010](decisions/0010-renderer-and-media-provider-adapters.md)) |
| `packages/media` FFmpeg | `@studix/renderers` (FFmpeg finishing) | Ported | |
| `packages/media` multix runner, capability matrix, registry | `@studix/providers` | Generalized | `MediaProvider` contract + Multix shell + fake; modalities not claimed beyond what is wired |
| `packages/pi-runtime` | `@studix/agent-runtime` | Generalized | `AgentRuntime` boundary + fake; worker-pod isolation instead of relying on the path guard |
| `packages/jev-router` + `packages/llm` | `@studix/decision-routing` | Generalized | `DecisionRouter` + `DecisionProviderAdapter`; OpenRouter, TypeSafeAI, Rules, Fake adapters ([ADR-0003](decisions/0003-jev-decision-provider-adapter-and-routing-fallback.md)) |
| `packages/director` | planning via `DecisionRouter("video.plan")` or host spec | Not yet ported | Director prompts and critique loops revisit in P2 |
| `packages/domain-pack` | `@studix/skills` | Generalized | Versioned templates; P0 ships the brand-intro template only, style content not ported |
| `packages/billing` ledger | `@studix/billing` | Replaced | Postgres usage ledger, COGS vs price ([ADR-0008](decisions/0008-billing-usage-ledger.md)) |
| `packages/billing` Polar, credit prices | none | Not yet ported | Pricing undecided |
| `packages/database` drizzle schema | `@studix/database` | Generalized | Tenant-scoped repositories, migrations ([ADR-0007](decisions/0007-tenancy-isolation.md)) |
| `packages/database` file repository | none | Replaced | Postgres is the only system of record |
| `packages/storage` R2 store | `@studix/storage` | Generalized | One S3 API adapter for R2, MinIO and others |
| `packages/storage` local disk store | none | Replaced | MinIO locally and in CI |
| `packages/observability` | `@studix/observability` | Ported | Span attributes extended to org/workspace/project/job/stage/provider/model |
| `packages/shared` sealed-box credentials | `secretRef` storage | Not yet ported | Encrypted credential store designed with connectors (P1) |

## Technical debt replaced

| Debt in the source | Why it blocks Studix | Studix answer |
|---|---|---|
| File/JSONL single-writer stores for records and ledger | Cannot run more than one app process; no migrations | PostgreSQL + Drizzle migrations |
| In-process job queue; interrupted jobs marked failed on restart | Pod restarts lose work | Postgres queue with lease, heartbeat, recovery |
| Pi path guard used as the containment for agent file access | A path guard is not a process sandbox | Agent work only in the isolated worker role; no shell; scoped credentials |
| Bearer-only MCP auth with static keys | No per-workspace revocation, no OAuth | Hashed, scoped, revocable workspace keys; OAuth plan ([ADR-0006](decisions/0006-auth-and-oauth-client-compatibility.md)) |
| multix video, voice, music and SFX not wired end to end | Cannot claim those modalities | Contract + shell only in P0; P2 wiring |
| Dashboard partial; search and billing planned/partial | Reviewers and admins need a working surface | P0 project/job/trace/connector views; search and billing in later phases |

## Branding and hostname rule

Runnable code (apps, packages, Dockerfile, infra, CI) must contain no `motion`
product branding and no `motion.digitop.ai` hostnames. Hostnames come from
`STUDIX_*_URL` configuration. The only allowed mentions of the source project
are attribution and provenance comments, and this documentation. A repository
search for `motion.digitop.ai` outside `docs/` should return nothing; CI may
enforce it.

No secrets, `.env` files or data directories are copied from the source.
