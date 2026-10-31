# Studix docs

Studix is an MCP-first AI video production harness. These docs own the **why**
and the **where**; the code under `apps/` and `packages/` owns the **what** and
the **how**. When a doc and the code disagree, the code wins and the doc is the
bug.

| Read this                                | When you need                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [PRODUCT.md](PRODUCT.md)                 | Vision, audience, AX/UX principles, P0 scope                                                           |
| [ARCHITECTURE.md](ARCHITECTURE.md)       | Package ownership, request flow, job lifecycle, trust boundaries                                       |
| [MCP_API.md](MCP_API.md)                 | The northbound `/mcp` tool contract and client connection guide                                        |
| [RENDERER.md](RENDERER.md)               | What the renderer supports, audio mix, loudness, deliveries, headless WebGL measurements               |
| [SECURITY.md](SECURITY.md)               | Tenancy, credentials, connector egress, approvals, threat list                                         |
| [DEPLOYMENT.md](DEPLOYMENT.md)           | Local, self-host, Cloudflare marketing, TOSE dev/prod, CI, runbook                                     |
| [ROADMAP.md](ROADMAP.md)                 | P0..P3 and the P0 done-means checklist                                                                 |
| [METRICS.md](METRICS.md)                 | Baseline metric definitions and results                                                                |
| [KNOWLEDGE_PACKS.md](KNOWLEDGE_PACKS.md) | Knowledge packs: stage-scoped loading, `hard`/`evidence` checks, pack lint, how to add a pack          |
| [QA.md](QA.md)                           | QA hard gate, evidence and human review, sandboxed measurement tools, limits, how to add a tool        |
| [PORTING.md](PORTING.md)                 | What was taken from `motion-mcp`, `zuey-workspace` and `agentkit`, at which SHA, and what was replaced |
| [porting/](porting/migration-matrix.md)  | Audit and migration matrix for the epic #2 sources                                                     |
| [decisions/](decisions/README.md)        | Architecture decision records                                                                          |

Status labels used across these docs:

- **Implemented**: exists in code and is covered by tests; the code is the reference.
- **P0 target**: accepted contract for the bootstrap; not proof that it ships.
- **Roadmap**: later phase; no code should assume it exists.

Source brief: [issue #1](https://github.com/digitopvn/studix/issues/1).
