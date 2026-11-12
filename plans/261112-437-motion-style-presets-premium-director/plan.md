# Motion-graphic style presets and premium director tier (#437)

Status: in progress

## Outcome

- Style profiles are presets that lock palette, type, pacing and juice. The aesthetic library gains the
  product/tech profiles of ak-motion-video (cinematic-product-launch, glass-keynote and a curated set of the
  neutral signature profiles), each with its own fonts, entrances, transition and juice.
- A brief that names a profile id gets that profile; the storyboard agent cannot swap it.
- Premium tier: a job that names a `roles.director` agent runs the motion-graphic storyboard on that agent
  (the stronger model) with larger caps, and the director may author 2-3 hero cards as custom HTML/GSAP in the
  HyperFrames composition format. Every hero card passes static safety rules and the HyperFrames linter
  before it is used, then the normal render QA gate; a card that fails falls back to the built-in card with a
  warning, so premium never fails a job that standard would render.

## Non-goals

- Beat snapping (#433), camera moves and match cuts (#434), vision critique loop (#435), brand kit from URL
  (#436). Hero cards go through whatever visual QA #435 adds to the render.
- Images or network media inside hero cards (inline SVG and CSS only).

## Design

| Part | Where |
| --- | --- |
| Profile `fonts`, `pacing` (enters, exit, transition), `juice` (ctaFill, whoosh) | `packages/skills/src/motion-graphic/motion-style-profiles.ts` |
| Template applies the preset; brief-named profile locks the storyboard | `motion-graphic-template.ts`, `motion-graphic-storyboard.ts` |
| Whoosh honours `metadata.juice` | `motion-graphic-pack.ts` accent stage |
| Fonts: Playfair Display, Oswald, Space Grotesk, Plus Jakarta Sans (all with Vietnamese subsets) | `packages/renderers/package.json` |
| `application/vnd.studix.html-card+json` composition shot: safety rules, inline compile, CSP, lint helper | `packages/renderers/src/hyperframes/html-card*.ts` |
| `roles.director` also drives `motion-graphic.storyboard` | `packages/core/src/studio/studio-types.ts` |
| Premium storyboard output `heroes[]`, `motion-graphic.heroes` stage (lint, store code asset, swap scene) | `motion-graphic-storyboard.ts`, `motion-graphic-heroes.ts`, pack |
| Docs | `docs/WORKFLOW_PACKS.md`, `docs/MCP_API.md`, `docs/RENDERER.md`, MCP `roles` description |

## Acceptance criteria

1. Every profile carries fonts, pacing and juice; the template output uses them (fonts in `brand.fonts`,
   entrances clamped to the profile's set, transition and CTA fill from the profile).
2. `directions[0].visualStyle: "<profile id>"` pins the profile even with an agent storyboard.
3. A job with `roles.director` runs the storyboard on the director and accepts `heroes`; without it heroes
   are dropped.
4. A hero card that breaks a safety rule or the linter is replaced by the built-in card and a warning; a
   valid one renders as an HTML-card composition shot that lints clean and renders in HyperFrames.
5. `pnpm check` passes; renderer compile+lint tests cover the HTML card.

## Validation

`pnpm check`; focused vitest for skills and renderers; one local HyperFrames render of a premium IR with a
hero card (frames inspected).
