# ADR-0026: Locked style profiles and premium hero cards for motion graphics

## Context

The motion-graphic pack drew every card from built-in shots, coloured by one of 28 style profiles that
only fixed a palette and a tempo. Type, entrance and transition followed the energy level, so two
profiles of the same energy looked alike, and an agent's storyboard could pick any entrance. A strong
director model could design better hero moments than the built-in cards, but the IR had no shot for its
own markup and nothing checked such markup before render (issue #437).

## Decision

- A style profile is a preset that locks palette, type (bundled Vietnamese-capable fonts), pacing
  (entrances one beat of its tempo) and juice (allowed entrances, exit, cut transition). The house and
  brand-inspired families of the ak-motion-video library are ported too (70 profiles); aliases naming
  real brands are dropped. A profile the brief names in `directions[0].visualStyle` wins over the
  storyboard's pick.
- The premium director tier is the `director` role on a `motion-graphic` job (or a host agent): the
  storyboard runs on that agent with larger caps and may hand-write HTML for up to 3 hero cards.
- The IR gets an `html` shot: an HTML fragment with one optional `<style>` block, no scripts or external
  resources, motion declared with `data-enter` / `data-at` / `data-duration` and played by the renderer's
  GSAP timeline. `lintHeroHtml` in `@studix/video-ir` is the allowlist; `validateVideoIR` rejects a shot
  that fails it, so no path can store or render unlinted markup.
- `RendererAdapter.inspect` is an optional pre-render visual QA. HyperFrames lints the compiled
  composition and captures each html shot where it settles, reporting lint errors, content outside the
  frame or its 3% margin, overlap with the caption band, clipped text and blank cards.
- The motion-graphic compose stage runs the visual QA before any paid stage. A hero that fails lint,
  the on-screen-line check or the visual QA is drawn as a built-in card with a warning; a renderer
  without `inspect` draws every hero built-in.

## Consequences

- Hero cards degrade to built-in cards instead of failing a job; the reason is in the storyboard stage's
  `warnings` or the compose stage's `heroQa`.
- The worker image carries four more font packages (Oswald, Playfair Display, Plus Jakarta Sans, Space
  Grotesk).
- Renderers other than HyperFrames report `html` shots as unsupported.

## Alternatives considered

- Hero cards as composition shots over a code asset: needs asset versioning for each card and a second
  capture path; an inline shot keeps the stored storyboard self-contained.
- Vision-model QA of the snapshots: costs a model call per card; the DOM measurements catch the
  layout faults that matter without spend.
