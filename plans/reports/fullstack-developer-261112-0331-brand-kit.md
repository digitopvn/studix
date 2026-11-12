# Brand kit for motion-graphic (issue #436, brand-kit half)

## Files changed
- packages/video-ir/src/creative-brief.ts: `brandUrl`, `brandLogo` (`BrandLogoSource`: https URL or base64 png/jpeg/webp/svg data URL, max 700,000 chars), `brandColors` (1-4 HexColor).
- packages/workflow/src/workflow-types.ts: `StageServices.fetchPublic`.
- apps/worker/src/media-exec-runner.ts: new `fetchPublic` (body, content type, final URL; same guard; adds a generic User-Agent); `fetchPublicUrl` wraps it.
- apps/worker/src/wiring.ts: `fetchPublic` wired into stage services.
- packages/skills/src/motion-graphic/motion-graphic-brand.ts (new): `motion-graphic.brand` stage, page parser, logo sniffing and storage (`brand/<jobId>/logo.<ext>`, asset `brand-logo`, provenance `brand`).
- packages/skills/src/motion-graphic/motion-graphic-template.ts: `brandSource` option, merge rules, hook/CTA lockup, version 9.
- packages/skills/src/motion-graphic/motion-graphic-pack.ts: stage in MG_STAGES, pipeline and pack; compose + recut pass `brandSource`; compose cacheKey includes it; skill description.
- apps/mcp-server/src/api/studio-routes.ts: REST body takes the three fields; native-tools.ts: brief description mentions them.
- docs/MCP_API.md, docs/ARCHITECTURE.md.
- Tests: packages/skills/test/motion-graphic-brand.test.ts (new), packages/video-ir/test/validate.test.ts, marketing-motion-templates.test.ts (template version constant).

## Decisions
- Stage output uses `warning` (one string, max 500) instead of `warnings[]`, so `studix_get_job` surfaces it through the existing stage-warning view.
- No stage cacheKey: it does network I/O and stores a job-scoped logo; the checkpoint covers resumes.
- An uploaded logo that fails falls back to the site's logo. Abort is rethrown (`s.signal.reason`).
- Without a real brand name, a logo is drawn alone (no lockup) so the hook line never becomes lockup text.

## Evidence
- `pnpm typecheck`: clean. `pnpm lint`: clean (pre-existing warnings only).
- `pnpm vitest run --project unit packages/skills packages/video-ir apps/worker apps/mcp-server`: 590 pass, 1 fail = json-schema snapshot (needs `pnpm schemas:export`).
