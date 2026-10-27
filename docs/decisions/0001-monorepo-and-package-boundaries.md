# 0001. Monorepo and package boundaries

- Status: Accepted
- Date: 2026-10-27

## Context

Studix needs one source of truth for domain logic shared by the MCP server,
dashboard, worker and marketing site. The reference project `motion-mcp`
already uses a pnpm TypeScript monorepo with one owning package per external
dependency. Issue #1 proposed eighteen packages, including `assets`, `review`
and `search`.

## Decision

- pnpm 10 workspace, Node >=22.19, TypeScript, Biome, Vitest with projects
  `unit`, `integration`, `live`. Scope `@studix/*`.
- Packages export `./src/index.ts`; apps run with `tsx`. Only `dashboard` and
  `marketing` have bundling builds.
- Apps: `marketing`, `dashboard`, `mcp-server`, `worker` (plus the
  `mock-mcp` test fixture).
- Packages: `shared, video-ir, core, database, storage, workflow,
  agent-runtime, decision-routing, providers, renderers, skills, mcp-gateway,
  auth, billing, observability`.
- **Consolidation:** `assets` and `review` live in `core`; their entities and
  service methods are small and share the same tenancy and versioning rules.
  `search` is deferred to P1, when there is a library to search.
- Each external dependency has exactly one owning package.

Ownership table: [ARCHITECTURE.md](../ARCHITECTURE.md#package-ownership).

## Consequences

- No build graph to maintain for libraries; type checking covers the workspace.
- `core` is larger; split `assets`/`review` out when either grows its own
  adapters or storage rules.
- Adding a provider or renderer touches one package.

## Alternatives considered

- Eighteen packages as listed in the issue: more boundaries than P0 code
  justifies.
- Microservices: rejected by the modular-monolith principle.
