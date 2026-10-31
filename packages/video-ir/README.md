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
- Shot types: `title`, `text`, `image`, `video`, `logo`, `cta` and `composition`. A composition shot
  points at a `code` asset (a GL scene or HyperFrames composition) with `assetId`, an optional `entry`
  and flat `params`. The asset must carry `assetVersionId`, so the IR stays declarative and a render is
  reproducible; which renderer can draw it is the renderer's `supports()` decision.
- `audio` tracks have a `kind` (`dialogue`, `voiceover`, `music`, `sfx`), placement (`startMs`,
  `durationMs`, `trimStartMs`), `volume` (0..1), `gainDb` (-60..12, applied on top of volume) and
  `fadeInMs` / `fadeOutMs` (both must fit inside `durationMs`). See `schemas/audio-track.schema.json`.

## Storyboard

`Storyboard` is the pre-production contract a genre pack fills before any media is generated:
`characters` (with reference assets and voice), `assets`, `beats` (with dialogue), `scenes` of
`shots` (`kind`, `description`, `durationMs`, `camera`, `beatIds`, `characterIds`, `assetIds`,
`dependsOn` for continuity) and an `approval` (`draft`, `in_review`, `approved`, `changes_requested`)
on the storyboard, every scene and every shot. `validateStoryboard` checks references, duplicate ids
and continuity cycles; `applyStoryboardPatch` edits it like a VideoIR; `pendingApprovals` lists what
still needs review.

## Dependency digests and invalidation

`videoIrNodes(ir)` and `storyboardNodes(sb)` describe a document as a dependency graph (format, brand,
assets, characters, beats, shots, scenes, document). `nodeDigests(nodes)` gives each node a Merkle
digest of its canonical JSON plus the digests of its dependencies, so a node's digest changes exactly
when it or something it depends on changes. `invalidatedNodes(before, after)` lists the nodes a patch
invalidated; everything else can reuse work cached under its unchanged digest. Approval status is not
part of a storyboard digest: approving a shot invalidates nothing.

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
