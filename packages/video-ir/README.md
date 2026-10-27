# @studix/video-ir

Renderer-neutral video intermediate representation (VideoIR) and the creative inputs around it
(`CreativeBrief`, `BrandKit`, `RenderSpec`). Renderers (HyperFrames, FFmpeg, ...) consume a validated
`VideoIR`; planners produce one. Nothing in this package knows about a specific renderer.

## Model

- `VideoIR` = `format` + `assets` (immutable `AssetRef`s pinned by sha256 + provenance) + `scenes`
  (content: `Shot`s with scene-relative timing) + `timeline` (absolute scene placement) + optional
  `audio`, `captions`, `brand`.
- All timing is integer milliseconds.
- `validateVideoIR(input)` never throws; it returns `{ ok: true, value }` or `{ ok: false, issues }`
  where each issue has a JSON pointer `path`, a `code`, and a `message`.
- A stored IR is immutable. Edits are `VideoIRPatch` (RFC 6902 subset) applied with `applyPatch`,
  which returns a new validated document and leaves the input untouched; each result is stored as a new
  project version.

## JSON Schema

`exportJsonSchemas()` returns draft 2020-12 schemas. `pnpm schemas:export` writes them to `schemas/`;
a unit test fails when the committed files drift from the zod source.

## Migration policy

1. `schemaVersion` is an integer. `VIDEO_IR_SCHEMA_VERSION` is the only version the code writes.
2. Additive, optional fields do not bump the version. Renames, removals, type changes, new required
   fields or changed semantics do.
3. A bump registers `VIDEO_IR_MIGRATIONS[n]` upgrading `n -> n + 1`. Migrations are pure, deterministic
   JSON transforms and must set `schemaVersion` to `n + 1`.
4. Stored versions are never rewritten in place: readers call `migrateVideoIR(doc)`; when `migrated` is
   true the caller stores the result as a new project version.
5. Documents newer than the running code are rejected (`VALIDATION`), never guessed at.
6. Every bump adds a golden fixture of the previous version under `fixtures/` plus a migration test.
