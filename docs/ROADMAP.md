# Roadmap

Phases come from [issue #1](https://github.com/digitopvn/studix/issues/1). Track
progress on the issues and PRs, not by editing dates or percentages here.

## P0: Bootstrap and technical vertical slice

Reuse the `motion-mcp` architecture where it holds up ([PORTING.md](PORTING.md)),
set boundaries and contracts, monorepo and CI, core + MCP + auth, MCP-in-MCP
registry with search/inspect/execute against a mock third-party server, durable
job with a minimal HyperFrames/FFmpeg path, Multix adapter shell with a
contract, Pi integration boundary, dashboard and marketing skeletons, staging
deploy and docs.

### P0 done means

Mirrors the bootstrap plan's contract. A box is checked only with evidence (CI
run, test, staging smoke, or URL).

- [ ] `apps/{marketing,dashboard,mcp-server,worker}` and packages; `pnpm install --frozen-lockfile`, lint, typecheck, unit, integration and build green in GitHub Actions with fake providers.
- [ ] README, `docs/{ARCHITECTURE,PRODUCT,ROADMAP,MCP_API,SECURITY,DEPLOYMENT}.md`, ADRs and `docs/PORTING.md`; no `motion.digitop.ai` in runnable code.
- [ ] `VideoIR` and project/scene/shot/asset/version/job schemas: validation, JSON Schema export, golden fixtures.
- [ ] E2E: MCP `studix_create_video` -> Postgres job -> IR -> HyperFrames -> MP4 in S3 -> `studix_get_job` signed URL; crash/restart, idempotency, cancel/timeout/budget, and publish-without-approval blocked.
- [ ] `DecisionRouter` with OpenRouter and TypeSafeAI adapters passing one shared contract suite; live calls opt-in.
- [ ] MCP-in-MCP meta-tools E2E against a mock Streamable HTTP server, plus the connector negative tests ([SECURITY.md](SECURITY.md#threat-list)).
- [ ] Hashed, revocable workspace API keys; cross-tenant access blocked, with tests.
- [ ] `/mcp` exercised by TS SDK and Python SDK clients; connection docs for Claude and ChatGPT.
- [ ] Dashboard: project, job and trace views, MP4 playback, mock connector add/test/disable.
- [ ] Marketing on Cloudflare at `studix.digitop.ai` returns 200.
- [ ] Staging on TOSE (workspace `wearetopgroup`, resources prefixed `studix-`): UI and `/mcp` at `app.studix.digitop.ai` pass the HTTPS smoke; a job survives a pod restart; runbook and rollback written.
- [ ] Docker Compose for local and self-host.
- [ ] Demo: Vietnamese prompt -> MP4 on the staging dashboard; baseline metrics recorded in [METRICS.md](METRICS.md).
- [ ] PR reviewed in isolation and merged; issue label matches state.

## P1: Previewable workflow

Project library, versions, assets, live progress, basic review and approval,
tracing and usage UI, provider connections, MCP connectors dashboard with
credential and outbound OAuth management, typed workflow binding for
connectors, search package.

## P2: Full video harness

Research, script, storyboard, remote video/audio generation through Multix,
advanced QA and feedback, publishing and search, brand-kit and team governance,
reusable workflow templates, Jev-aided tool reranking, optional sandboxed MCP
Code Mode.

## P3: Commercial and scale

Usage billing, on-prem hardening, provider routing optimization, GPU-capable
execution, professional multi-tenant operations.

## Separate tracks

- **anime-creator port**: turning `anime-creator` into a reusable Studix
  workflow and skills is tracked in
  [issue #2](https://github.com/digitopvn/studix/issues/2).
- **GPU droplets / self-hosted generation**: future `ExecutionBackend` or
  provider adapter; verify deployment rights and hardware before committing.
- **Domain cutover** to `studix.io`: config-only by design
  ([DEPLOYMENT.md](DEPLOYMENT.md#domain-cutover-to-studixio)).
