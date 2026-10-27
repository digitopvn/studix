# 0010. Renderer and media provider adapters

- Status: Accepted
- Date: 2026-10-27

## Context

The core must not equate video with one renderer or one generation provider.
HyperFrames (HTML-based composition rendered by headless Chromium) and FFmpeg
already work in `motion-mcp`. Multix (`mrgoonie/multix-cli`) fronts many
generation providers, but its video, voice, music and SFX paths were not wired
end to end in the reference.

## Decision

- `RendererAdapter` (port in `@studix/core`, implementations in
  `@studix/renderers`): **HyperFrames first** for composition and assembly,
  FFmpeg for finishing and probing. Versions pinned in the image.
- `MediaProvider` (port in `@studix/core`, implementations in
  `@studix/providers`): capability-registry based (image, video, voice, music,
  SFX, upscale). P0 ships a **Multix shell** that satisfies the contract and a
  fake provider; it does not claim modalities that are not wired end to end.
- Providers are invoked through allow-listed CLI or MCP calls with a scrubbed
  environment; costs, versions and provenance are recorded per execution.
- Fallback policy is declared per capability; missing capability fails with a
  typed error instead of silently degrading.
- One contract suite per port; CI uses fakes.
- Future GPU and self-hosted generation arrive as new `ExecutionBackend` or
  provider adapters.

## Consequences

- The P0 demo is template motion graphics with no AI image or voice.
- Adding a renderer or provider is a new adapter plus contract tests.

## Alternatives considered

- Call HyperFrames from workflow code directly: locks the core to one renderer.
- Integrate each generation vendor separately in P0: scope far beyond the
  vertical slice.
