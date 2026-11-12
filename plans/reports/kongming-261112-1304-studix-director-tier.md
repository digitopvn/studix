# Kongming: tier director cho Studix motion-graphic

## TL;DR

Stop adding layout types. The template path plateaus because its unit of design is a card with slots, filled by one cheap call that sees neither word timings nor pixels. Add a "director" tier where agents author one bespoke HTML/GSAP scene per beat against a Studix-owned shell, with a calibrated blind judge as the gate.

Before building anything, run the path you already shipped once on the dogfood prompt: `skill-agent` with director/builder/QA roles and the bundled `ak-motion-video` skill. That run has never been dogfooded and it tells you which half of the problem is left.

## Reframed problem

The decision is not which features B is missing. It is where the creative decisions get made, and with what information.

- **Requirements:** B at or above A v2 in the user's own blind judgment, on one MCP call, with scenes still individually editable.
- **Goal:** much faster and cheaper than A (3 h 04 min, a few USD plus heavy tokens).
- **Non-goals:** replacing the cheap tier; matching A's process.
- **Constraints:** one sandbox runner per job, and prod may have no sandbox at all.

## 1. Why the template plateaus

I viewed both contact sheets and cut 20–28 s frame strips from both films.

1. **The grammar is wrong, not the parts.** Every B card is headline on top, one device below, caption at the bottom. The same sentence is shown twice and spoken once. In B's strip, "Real typography. Your exact brand colours." sits alone for about 3 s before the swatches appear. A has no mid-film headlines: the product UI is the scene and the caption carries the words. In the same 8 s, A moves through job rail, three crew cards, type spec and swatches. More devices cannot fix a grammar of one idea, one state, per card.

2. **The author is blind to time and pixels.** The storyboard is written before the voice exists, in at most 4 turns and 15¢ (`origin/main:packages/skills/src/motion-graphic/motion-graphic-storyboard.ts:31`). Choreography is then derived by generic rules. That is the mechanism behind #468 (devices late). A's builders bind motion to spoken words: `W(sid, "cent")`, `W(sid, "stops")` in `video-a-v2/scenes/s09-credits.scene.html`.

3. **Nothing exists at film level.** A's director wrote a concept, a rhythm with two drops, and one shape carried through every scene with exact handoff rects. B's motif dot is a rule-added decoration with no intent behind it, hence #469.

4. **Expressiveness is capped by Studix code.** Every new visual need is a PR. The premium hero card does not lift the cap:
   - it is declarative only: at most 40 tweens, limited to transform, opacity and stroke-draw (`origin/main:packages/renderers/src/hyperframes/html-card.ts`);
   - it is written inside the storyboard call, before timing exists (`motion-graphic-storyboard.ts:194-211`);
   - it is told to "animate in within the first second, then hold".
   
   So it cannot type text, roll a counter, tween a width or colour, anchor to a word, or hand off across scenes. A's s09 does all of these. A hybrid built on today's hero cards cannot reach A.

5. **The feedback loop cannot change what matters.** Visual QA scores one hold frame per card and can only ask the storyboard to re-pick template parameters (`origin/main:packages/skills/src/motion-graphic/motion-graphic-visual-qa.ts`). A's reviewer issues at most eight ranked, concrete notes, each routed to the builder that owns that scene's code.

6. **The improvement loop tracked defects, not preference.** The report predicted the gap closing after each round, and the user still said no six times. A defect list does not predict this user.

## 2. Recommended architecture: authored scenes on a Studix-owned shell

This ports the skill's division of labour as a deterministic workflow, not a free-roaming agent. Keep the standard tier untouched as the fast $1 path and as the per-scene fallback.

| Stage | Who | What |
|---|---|---|
| 1. Facts and script | mid-tier model, one call | Script, plus a facts list every on-screen claim must trace to (A has this step; B has none) |
| 2. Direction brief | strongest model, high effort, one call, parallel with audio | Concept, carried motif, rhythm and drops, per-scene shot, focal words and exit handoff, in the format of the skill's `references/orchestration.md` |
| 3. Audio | existing B stages | Voice, music, beat grid, word timings. Unchanged |
| 4. Scene builders | mid-tier, 4–5 calls in parallel, tool-less, structured output | One `scenes/<sid>.scene.html` fragment each (section, scoped style, script), using only shell helpers. Inputs: brief header, own scene section, neighbours' exit lines, word timings |
| 5. Assemble and draft | one sandbox session | Splice into the shell, lint, bounds check, draft render, per-scene frame strips |
| 6. Taste review | strongest model, vision, fresh context | At most 8 ranked notes, each naming scene, time and change. At most 2 rounds |
| 7. Targeted rewrite | the builder call for that scene only | Re-emit the fragment, re-render touched scenes |
| 8. Final | sandbox | Final render, existing ffprobe and loudness contract |

Design rules that make this work:

- **The shell is a product asset, not generated.** A's shell is 46 KB against 109 KB for all eleven scenes. Ship the helpers (`W`, `B`, `pop`, `slam`, `settleCam`, flash, captions, the handoff map) as versioned Studix code. Builders write only scenes, which is how A got consistent quality from mid-tier builders.
- **Builders are plain model calls, not sandbox sessions.** A job holds one runner for its whole run, so in-sandbox parallel builders are out. Tool-less calls fan out inside a stage, as `VOICE_CONCURRENCY` already does for voice.
- **Scene scripts run only in the sandbox.** Agent code already runs there under ADR-0022. It must never reach the in-worker renderer; `html-card` stays the in-worker format for the standard tier.
- **Scenes stay addressable.** Store fragments in the composition tree under `compositions/<id>/` (ADR-0024), so "edit one scene" re-runs one builder and one render. `skill-agent` returns a single MP4 in a one-shot IR and loses this.
- **A failed scene falls back to its template card.** A director job then never fails where a standard one renders, as the heroes stage does today.

**Targets (estimates except where marked):**

- **Time:** 15–20 minutes. The anchor is B r6's measured 11 min 27 s on prod hardware. Authoring overlaps the audio stages; add one draft render and one or two review rounds. Sidecars default to 1.5 cores, so A's Mac render times do not transfer.
- **Cost:** $2.50–4.00. Audio is about $1.05 measured (music is 90¢ of it). Scene authoring is roughly 30–40k output tokens, since A's eleven scenes total 109 KB. Director and two vision reviews are well under $1 each.
- That is about 10 times faster than A, at similar or lower cash cost, without A's orchestration token overhead.

**Quality gates, in order:**

1. Lint: 0 errors.
2. Bounds check: no caption violations, 20 px label floor.
3. No scene with under 40% of its hold time showing its main visual (catches #468 mechanically).
4. A drop bar is never darker than the bar before it (A's own lesson).
5. Reviewer verdict "ship" or two rounds used.
6. The judge fails closed when the model reports it could not see the images (#471).

## 3. Plan and the deciding metric

1. **Baseline what is already built (1 day, no new code).** Run the dogfood prompt through `skill-agent` with roles: director and QA on the strongest model, builder mid-tier, with the bundled `ak-motion-video`. Caps are 40 min and 800¢. Measure time, cost and the judge score from step 2.
   - If it matches A, the remaining work is addressability and speed, not craft.
   - If it does not, you have the exact gap the authored-scene tier must close.
   - Precondition: a sandbox-enabled environment; see Assumptions.
2. **Build the judge and calibrate it.**
   - Format: blind pairwise, per-scene frame strips at about 2 fps plus one whole-film sheet, order randomised, 10 trials.
   - Calibration: it must prefer A v2 over every B round (the only user-verified pairs) and put r0 last.
   - If it cannot reproduce those, fix the judge before using it.
   - Measurable: agreement rate on the existing nine videos.
3. **Ship the shell and one authored scene.** Extract the shell from the skill into Studix, add the fragment contract and sandbox assemble/render. Replace only the hook scene on the dogfood prompt. Measurable: that scene wins its pairwise against r6's card 1.
4. **Full director tier.** Director brief, parallel builders, template fallback per scene. Measurable: whole-film judge against A v2, time under 20 min, cost under $4.
5. **Review and targeted rewrite loop.** Measurable: judge win rate rises between round 0 and round 2 on the same job; no job exceeds the time cap because of review.
6. **Per-scene edit on authored scenes, then three unrelated prompts.** Measurable: an edit re-renders one scene; the tier beats the standard tier on all three prompts.

**The metric that decides "B ≥ A":** B wins at least 6 of 10 blind pairwise trials on each of two different judge models, with every hard gate passing. Then the user watches two unlabelled files in random order and picks. Only the user's pick closes the question; the judge exists to stop wasting the user's rounds.

## 4. Risks and what to avoid

- **Do not extend `html-card` toward a scripting language.** More tween properties and word anchors would rebuild GSAP badly, and still leave cross-scene handoffs out.
- **Do not port the 3-hour process.** A's cost came from a dozen sessions each re-reading the contract, shared-machine renders and three review cycles. Port the roles and the artifacts, not the session count.
- **Do not let the judge become the target.** Recalibrate whenever the user disagrees with it, and keep the three extra prompts so the tier is not fitted to one brief.
- **Do not put generative imagery first.** A beats B with no generated imagery in its scenes. Reference frames add cost and a new failure class for a gap that is choreography and structure.
- **Do not build a larger component library as the main bet.** It is the current approach with a higher ceiling. It is worth having later as snippets builders may copy from, not as slots.
- **Runner contention:** a director job holds a runner for its render session. Keep that session short (assemble and render only) so pool size does not become the throughput limit.
- **Reviewer blindness:** #471 suggests the QA model may not have seen the sheet. Any score from a model that cannot confirm it saw frames must count as a fail.

## Alternatives and trade-offs

- **`skill-agent` as the product path.** It is already built and may match A today. It costs up to 40 min and $8, has no parallelism, and returns one opaque MP4. Choose it if step 1 matches A and per-scene edit is declared out of scope for this tier.
- **Hybrid: template skeleton with 2–3 authored hero scenes.** Cheaper and faster, about $1.50 and 13 min. The film still reads as cards between heroes, and the carried motif breaks at every template scene. It is a reasonable step 3.5, not the destination.

## Assumptions

- **r6 ran the standard tier, not premium with a director role** (medium confidence, from the caller's description of a single DeepSeek call). If premium was used and hero cards rendered, point 4 of the root cause is confirmed by experiment, not by reading.
- **Prod has no sandbox enabled** (medium). The deploy config shows no `STUDIX_SANDBOX` setting, `docs/DEPLOYMENT.md` names only the dev worker, and ADR-0025 says prod is unchanged until it opts in. Step 1 therefore needs the dev key re-granted or a prod opt-in.
  - This is the user's call. My default is to allowlist only the dogfood workspace in `STUDIX_SANDBOX_SIDECAR_WORKSPACES`, not `*`.
- **A tool-less agent stage does not take a runner** (medium; inferred from tools being optional in `origin/main:packages/workflow/src/agent-stage.ts`, not traced end to end). If it does, builders must be direct provider calls outside the agent stage.
- **A v1 (`--poor`, 18 min) is known only from the report;** I did not view it. If it already beats r6, a single-session run is closer to the bar than this advice assumes.
- **The user's bar is A v2 as a whole film,** not a specific feature of it (high).
- **All cost and time targets are estimates** from A's file sizes and B's measured stage times, not from a run.
- **Citations refer to `origin/main`.** Neither working tree holds the heroes, html-card or visual-QA files; the worktree branch is behind.

Runtime note: this consult ran on Fable 5.2.