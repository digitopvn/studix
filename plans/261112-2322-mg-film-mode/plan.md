# Motion-graphic film mode (director tier authors every scene)

Status: in progress. Branch `feat/mg-film-mode` from `origin/dev`. PR into `dev`, not merged.

## Outcome

Director tier authors every scene on one shared film system (one product-UI surface, one hue, persistent
chrome, CTA mirrors the hook) so the film reads as one product film. Old jobs (shell v1) keep rendering.

## Acceptance

- Brief has `system` and optional `mark`; mark sanitized, monogram fallback, `metadata.generatedMark` plus a
  warning.
- Shell v2 file (v1 kept): chrome layer on absolute film time, `sx-panel/pill/chip/caret/rail`, `#sx-mark`
  symbol, per-scene try/catch attribution, scene-relative `B(n)`.
- Builder v6: the hook keeps its headline rule; other scenes get no headline rule and no onScreen, the main UI
  fills at least 60% from frame 0.
- Fan-out (concurrency 5) with per-call budget grants (about 15c expected per scene), one parallel contract
  repair.
- Sandbox run 1 = film check, findings attributed per scene (`#sc-<sid>`, `studix-scene <sid>`, time window);
  failed scenes become template cards. Run 2 = film render (1200 s timeout), ffmpeg split per frame range, luma
  at cuts.
- Bokeh off on template cards of a film with authored scenes (renderer, from IR metadata).
- Blank-cut gate (luma at cut +-2 frames against the background) flags scenes; visual QA repairs the worst 3
  authored scenes at most.
- Tests: fan-out, attribution, split command, budget admission, mark fallback, blank-cut gate.

## Phases

1. renderers: `director-shell.v2.html`, `director-shell.ts`, `director-mark.ts`, `scene-fragment.ts`,
   `director-film.ts` (split and luma commands, attribution, blank cuts), bokeh gate in
   `scene-composition.ts` / `scene-depth.ts` / `compile-composition.ts`, with tests.
2. skills: `motion-graphic-director-agents.ts` (brief, builder v6), `-director-timing.ts` (film timing),
   `-director-film.ts` (new: fan-out, budget, film runs), `-director.ts` (stage), `-director-clip.ts` and
   `-director-repair.ts` (shell version, per-scene task), `-visual-qa.ts` (worst 3, midpoint, blank cuts),
   with tests.
3. Verify: focused vitest, `pnpm typecheck`, biome on touched files; PR.

## Risks

- Not run against a live sandbox: hyperframes runtime finding shape, ffmpeg in the sandbox image, film render
  time.
- Budget: 12 scenes at about 15c plus 2 sandbox runs; the tier degrades to fewer authored scenes when the budget
  is short.
