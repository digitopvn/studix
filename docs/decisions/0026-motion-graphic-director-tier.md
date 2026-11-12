# 0026. Motion-graphic director tier: authored scenes on a Studix-owned shell

- Status: Accepted
- Date: 2026-11-12
- Extends: [ADR-0022](0022-agentic-video-authoring.md), [ADR-0024](0024-client-authoring-and-agent-roles.md)

## Context

The motion-graphic template tier fills one card at a time with a cheap call that sees neither word timings nor
pixels. Hero cards (`html-card`) are declarative and capped, so they cannot type text, roll a counter, anchor a
move to a spoken word or hand a shape across a cut. The ak-motion-video reference gets its quality from builders
that each write one HTML/GSAP scene against a shared shell of helpers, with the real timings in hand.

## Decision

- Studix owns a versioned shell, `packages/renderers/src/hyperframes/director/director-shell.v<N>.html`. It is
  extracted from the skill's skeleton and film helpers and holds the `TIMING` injection, `W`/`WE`/`B`, the
  animation vocabulary (`pop`, `slam`, `settleCam`, `flash`, ...), captions, the handoff map, and theme tokens
  from the brand kit and style. A new version is a new file.
- A scene fragment (`scene-fragment.ts`) has three parts. `html` is the section content. `css` is scoped by
  Studix under the section. `js` is a choreography body with only the shell's helpers in scope. Studix checks a
  fragment before use:
  - size caps;
  - no scripts, media, links, handlers or URLs;
  - no at-rules, animations or transitions;
  - a JS syntax check;
  - no network, timers, wall clock, `Math.random`, or GSAP outside `tl`;
  - every word passed to `W()` is spoken in the scene.

  These checks keep renders deterministic and offline. They are not the security boundary.
- Premium jobs (`roles.director`) on a worker with a skill sandbox run the `motion-graphic.authored-scenes` stage
  after the hero cards. Both agent calls are tool-less structured output:
  - The director call (`motion-graphic.direction`, director role) writes a brief: concept, motif, rhythm, and
    per scene the shot, focal words and exit.
  - The builder call (`motion-graphic.scene-build`, builder role, else the job's agent) authors the hook scene
    with its real word timings and beat grid.
- The shell, fragment, timing and brief are stored as a composition tree (`compositions/<id>/`, with the fragment
  at `scenes/<sid>.scene.html`). The sandbox runs `hyperframes check` (lint, runtime errors, layout), then renders
  a silent clip of the scene. The clip is copied to `generated/<job>/authored/` and replaces the hook card as a
  muted full-frame video shot. The in-worker renderer draws the captions, the sound and the other cards as
  before. Agent-written scripts never run in the in-worker renderer.
- When anything fails, the template card stays and the job gets a warning. Failures include no sandbox, a cap, a
  contract break, and a failed check or render. A premium job therefore never fails where a standard one renders.
  Spend is booked either way.

## Consequences

- The voice stage keeps heard word timings in `metadata.spokenWords`.
- The visual review never redesigns an authored scene as a template card. It scores the scene's still with the
  cards; a failing scene goes back to its builder once with the review's issues and is rendered again in the
  sandbox. A failed or unaffordable repair keeps the current clip.
- The stage needs `STUDIX_SANDBOX`. On the sidecar backend only allowlisted workspaces
  (`STUDIX_SANDBOX_SIDECAR_WORKSPACES`) get it. For other workspaces, and on workers without a sandbox, the
  stage does not start: nothing is paid and the graphic is unchanged. Production runs it only after
  it opts in ([ADR-0025](0025-sidecar-skill-runner.md)).
- Re-rendering a stored version reuses the clip.

## Amendment: film mode

One authored hook among template cards read as a slide deck. The tier now authors every scene:

- The direction adds `system` (one product-UI surface carried through the film, the hook's panel rect that the call
  to action returns to) and, when the brand kit has no logo, `mark` (an SVG sanitized to plain shapes; otherwise a
  monogram; recorded as `metadata.generatedMark` with a warning).
- Shell v2 (`director-shell.v2.html`) adds a chrome layer on absolute film time, the `sx-panel`, `sx-pill`,
  `sx-chip`, `sx-caret` and `sx-rail` components, the mark as `#sx-mark`, scene-relative `B(n)` and a per-scene
  `try` that logs `[studix-scene <sid>]`. Shell v1 stays for stored compositions.
- Builders run in parallel, each on its own budget grant. The sandbox checks the whole film once and attributes
  findings to scenes, then renders the film once and cuts one clip per scene on exact frame ranges. A scene that
  fails anywhere keeps its card; cards of a film with authored scenes draw no bokeh.
- The frames around every cut are measured; a scene that opens or closes on a blank frame is flagged, and the visual
  review sends it, with the three worst-scoring scenes at most per round, back to its builder.
