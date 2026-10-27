# 0002. VideoIR and domain contracts

- Status: Accepted
- Date: 2026-10-27

## Context

The workflow must stay neutral across renderers (HyperFrames now, others
later), video genres (motion graphics, anime, live action) and AI providers.
`motion-mcp` proved a schema-first, renderer-neutral IR with immutable versions
and patches, but its `MotionIR` is specific to motion graphics.

## Decision

- `@studix/video-ir` owns zod schemas `VideoIR`, `Scene`, `Shot`, `Timeline`,
  `AssetRef`, `BrandKit`, `CreativeBrief`, `RenderSpec`, plus
  `validateVideoIR()` and `exportJsonSchemas()`.
- Every document carries `schemaVersion`; a migration registry upgrades old
  versions forward. Golden fixtures in `fixtures/` pin the contract.
- `@studix/core` owns entities (`Organization`, `Workspace`, `Member`,
  `VideoProject`, `ProjectVersion`, `Asset`, `AssetVersion`, `Render`,
  `WorkflowRun`, `Job`, `Stage`, `Review`, `Approval`, `ProviderExecution`,
  `UsageEvent`, `AuditEvent`) and port interfaces (`MediaProvider`,
  `RendererAdapter`, `AgentRuntime`, `DecisionProvider`, `StorageAdapter`,
  `ExecutionBackend`, `PublisherAdapter`, `BillingPolicy`).
- Versions are immutable; edits create a new version. Binaries are referenced
  by `AssetRef`, never embedded.
- `video-ir` imports no renderer or provider. Motion graphics is a
  specialization expressed through templates and renderer adapters.

## Consequences

- MCP tools return JSON Schemas from the same zod source, so clients and code
  never drift.
- Schema changes require a version bump and a migration, enforced by fixtures.

## Alternatives considered

- Port `MotionIR` unchanged: ties the core to one genre.
- Renderer-native documents (HyperFrames HTML) as the source of truth: locks the
  core to one renderer.
