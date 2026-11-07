# Motion craft: the production bar

Direct the video as a senior motion designer delivering a finished production
piece for a real launch, not a demo, prototype or template walkthrough. The
viewer should feel the motion before they read the words. Style profiles decide
*which* moves are allowed; this file decides *how well* they are executed.
Everything here runs inside `composition-contract.md` (paused timeline, TIMING,
seeded randomness) and the base profile's constraints.

## Scale the juice to the style

Juice is the amount of anticipation, overshoot, impact and secondary motion.
Read the base profile's `energy` and its `constraints` first; a constraint such
as "no shake" or "every tween eased, no bounce" always wins.

| Energy | Juice budget |
|---|---|
| 1–2 (cinematic, calm, premium) | No shake, bounce or elastic. The juice comes from exquisite easing, overlap, parallax depth, light sweeps, match-moves and held stillness. |
| 3 (product, editorial) | Soft overshoot (`back.out(1.4)`), smears on UI, one impact per section on a drop (`slam(el, t, { soft: true })`, flash without shake). |
| 4–5 (comic, sport, hype) | Full vocabulary: slams, squash and stretch, shake, smear frames, impact frames, particle bursts on kicks. |

## Principles every scene obeys

1. **One focal point per moment.** Decide where the eye goes on every beat and
   move only what serves it; everything else holds or drifts.
2. **No dead frames.** A hold is at least one beat of stillness for reading,
   carried by micro-motion: `settleCam` push-in (1.00 → 1.03–1.05), a slow
   parallax drift or a light sweep. Nothing on screen is ever fully frozen.
3. **Overlap, never queue.** The next action starts while the previous one is
   still settling, 30–60% into it. Staggers use an eased distribution
   (`stagger: { each: 0.05, from: "center", ease: "power1.in" }`), never
   uniform 0.1 s steps.
4. **Anticipation → action → follow-through.** Big moves wind up 2–4 frames the
   other way, overshoot, then settle. Secondary parts (shadows, labels, icons,
   underlines) arrive 2–4 frames after the primary part and settle later.
5. **Designed easing.** Entrances `expo.out` or `power4.out` (fast, then a long
   settle); camera and layout moves `power3.inOut` or `expo.inOut`; exits are
   ~60% of the entrance duration with an `.in` ease. Never `linear` (except
   opacity holds and `settleCam`), and never the default `power1`.
6. **Arcs, not rails.** Moving objects travel on curves: tween `x` and `y` with
   different eases (`x: expo.out`, `y: power2.inOut`), or add a small rotation
   that resolves on landing.
7. **Continuity across cuts.** A scene hands off to the next one: a shape grows
   into the next background, the hero shrinks into its slot (match-move), or
   motion keeps its direction through a whip. A fade to nothing and a rebuild
   is the fallback, not the default.
8. **Depth.** At least three layers: background (slowest, may be blurred and
   baked), midground content, and a foreground accent (particles, a bokeh or
   glass shape, a frame edge) moving fastest. Parallax ratio ≈ 0.3 : 1 : 1.6.
9. **Rhythm is edited.** Big moves land on downbeats and `TIMING.drops`, reveals
   on the spoken keyword (`W(sid, word)`), micro accents on off-beats. Vary the
   density: calm set-up → build → drop → breathe. Three equal-energy scenes in a
   row read as a template.
10. **Readable.** Text holds at least 0.4 s + 0.06 s per word after it settles.
    Motion never runs behind a line while it is being read.
11. **Cadence.** Something visibly changes every 3–5 s. A scene longer than
    ~7 s gets an internal cut-in (wide, then a close on the spoken keyword) so
    no framing holds past 8 s; `story-and-shots.md` has the shot sizes.
12. **No repeated camera.** Adjacent scenes never use the same camera move;
    prefer alternating scale, translate and static families, and keep `static` for the
    payoff (`story-and-shots.md`).

## Technique cookbook

The skeleton ships `slam`, `smear`, `lineIn`, `settleCam` and `shake` next to
`pop`, `rise` and `draw`. Build the rest from GSAP on the one timeline.

| Technique | Recipe | Use for |
|---|---|---|
| Slam / impact | `slam(el, W(sid, "word"))`: lands oversized and blurred on the word onset, squashes 3 frames, elastic settle | hero numbers, titles on a drop |
| Squash and stretch | on landing `scaleX: 1.08, scaleY: 0.9` for 2–3 frames, then `elastic.out(1, 0.5)`; keep volume (x × y ≈ 1) | mascots, badges, icons |
| Smear frame | `smear(el, t, { dx: -300 })`: skew in the travel direction and settle to 0; for a longer blur add 2–3 ghost copies (`.ghost`) at 0.35/0.2/0.1 opacity trailing by 1 frame each | fast lateral entrances, whip transitions |
| Masked line reveal | wrap each line in `overflow: hidden`, then `lineIn(words, t)`: words rise from below the mask with a slight rotation that resolves | headlines, kinetic type |
| Kinetic keyword | the spoken keyword scales 1 → 1.12 → 1 on its onset, turns accent colour, tracking tightens from 0.04em to -0.02em | emphasis inside a sentence |
| Whip pan | outgoing stage `x: -W, skewX: 12` over 0.22 s `expo.in`, incoming from `+W` with `expo.out`, on a beat; add a 1-frame speed-line layer | energetic scene changes |
| Zoom-through | current scene scales 1 → 2.4 with opacity to 0 over 0.3 s `expo.in` while the next scales 0.85 → 1 | reveal of a detail or product |
| Shape wipe | an accent block sweeps across (`scaleX` 0 → 1 from the left, then 1 → 0 to the right) and the scene swaps under it at the midpoint | clean branded transitions |
| Iris / clip reveal | `clipPath: circle(0% at x y)` → `circle(150% ...)` on `expo.inOut` (count toward the clip-path budget) | focus on a UI element |
| Camera push and rack focus | wrap a scene in a camera group; `settleCam` during holds; rack focus by swapping `filter: blur()` between two baked layers over 0.4 s | premium holds, depth |
| Impact frame | 1 frame of `#flash` at 0.6–0.9, then `shake` decaying over 6 frames, optional 2-frame RGB split | drops, big reveals (energy ≥ 4) |
| Light sweep | a skewed white gradient bar crosses a card inside its mask over 0.6 s `power2.inOut`, opacity ≤ 0.35 | premium cards, product glints |
| Particle burst | 8–16 prebuilt dots, seeded `rng` angles and distances, `expo.out` outward, fade late, slight gravity on `y` | clicks, unlocks, achievements |
| Counter | `odo` with `power3.out` so it decelerates into the value, then a 1.06 bump and an accent flash on the final digit | stats |
| Chart growth | bars grow with `back.out(1.3)`, staggered from the tallest; lines `draw` with a leading dot riding the path | data scenes |
| UI choreography | cursor travels on an arc and decelerates, a press is `scale: 0.96` for 3 frames plus a ripple, panels cascade with overlap, then the result lands with a soft overshoot | product demos |
| Collage assembly | baked pieces (`generated-art.md`) start off-frame or oversized and fly to their **home** positions, so the settled frame reconstructs the original poster; under each piece, its home spot on the backdrop is blurred (not dimmed) until it lands, which avoids a ghost copy or a dark patch | paper, print and poster styles |
| Fly-in | from off-frame on an arc (`x: expo.out`, `y: power2.inOut`) with 6–15° of spin that resolves on landing, then a 2–3 frame settle | cut-outs, stickers, hero props |
| Slap | from scale 1.4 and slight blur straight onto its spot in 4–6 frames `expo.out`, then a soft shake on the parent | stamps, labels, cut-out headlines |
| Drop | from above with `bounce.out`, the shadow tightening and darkening on landing | pieces landing on a desk or board |
| Pop-settle | in place, opaque, scale 1.35 → 1.00 `power3.out`; no travel, so it cannot ghost over a full backdrop | focusing one piece of a full poster |
| Sway and breathe | after landing, seeded low-frequency `rotation` ±1–2° and scale 1.00–1.015 yoyo with finite repeats sized to the hold | settled pieces during holds |
| Confetti drift | 20–40 prebuilt scraps in the palette's colours drift and rotate slowly through the whole scene, seeded; a denser burst on a drop | tactile energy for paper, pop and party styles |
| Still pan (Ken Burns) | a baked still slowly scales 1.00 → 1.08 and translates 2–4% across the hold, `power1.inOut` | photos and generated art when nothing else moves |

Rules for the cookbook:
- Heavy effects (`filter`, `clip-path`, big gradients) follow the renderer
  limits: attach them only while they run and set them back to `none`.
- Ghosts, particles and wipe layers exist in the DOM before the first tween;
  only their tweens are scheduled.
- Camera shake, whips and pans over a full-bleed backdrop run on a stage
  oversized by ~1.2× (overscan), so translation never reveals an empty edge.
- On a piece that settles over a full backdrop, use an `.out` ease for scale,
  not `back`: `back` overshoots below 1.0 and briefly shows what is behind it.
- A technique that the base profile's `avoid` or `constraints` rule out is not
  used, even when it would add juice. When the profile gives its own values for
  a technique (a zoom scale, a wipe direction), use the profile's values.
- Line masks, reels and sweep masks carry `data-layout-allow-overflow`, or
  `check` reports their clipping as an error.

## Replace demo tells with production choices

| Demo tell | Production choice |
|---|---|
| Everything fades in with opacity only | Each element has an entrance verb: rise out of a mask, slam, smear, draw, grow from its anchor |
| Same duration and ease everywhere | Durations vary with mass and distance; small UI parts are faster than big panels |
| All elements start together | Choreographed overlap with a clear lead element |
| Centred text on a flat background, scene after scene | Framed compositions: asymmetric layouts, scale contrast, depth layers, product UI in context |
| Every scene built the same way | Each scene type has its own choreography; recurring types follow the reference demo |
| Hard cut, then rebuild from empty | Transitions that carry motion, shape or colour into the next scene |
| Motion stops dead at the end of a tween | Overshoot and settle, then micro-motion until the exit |
| Placeholder copy, default borders, stock gradients | Real facts, designed components, baked textures |

## Director's pass (per scene, before rendering)

Check each scene against this list and fix what fails:
- The focal point on every beat is obvious, and the hero moment lands on the
  spoken keyword or a drop.
- There are three depth layers, and at least one element keeps moving during holds.
- Every entrance has anticipation or a mask, and every landing has follow-through.
- The exit hands off to the next scene (match-move, whip, wipe or zoom-through).
- The camera move differs from the neighbouring scenes', and a scene longer
  than ~7 s has an internal cut-in.
- Text is readable for its full hold; captions and the signature are untouched.
- The juice level matches the base profile's energy and constraints.

## Reviewing motion cheaply

Stills hide motion problems, and watching full renders costs time and context.
Render one draft and read each scene as a contact sheet (one small image per
scene, 18 frames spread evenly across the whole scene):

```bash
npx --yes hyperframes@0.8.77 render -q draft -o renders/draft.mp4
ffmpeg -v error -y -ss <scene start> -t <scene length> -i renders/draft.mp4 \
  -vf "fps=18/<scene length>,scale=232:-2,tile=6x3" -frames:v 1 renders/sheet-<sid>.jpg
```

`python -X utf8 <skill>/scripts/contact-sheet.py renders/draft.mp4 --timeline data/timeline.json`
writes the same sheet for every scene (or `--scenes a..b`). Keep sheets at
1400 px wide or less, which is the default. Full-size sheets (1816×3295 in
one run) are blocked by context firewalls and cost far more tokens than they
show.

The sheet covers the entrance, the holds, the exit and the handoff, and shows
whether moves overlap, overshoot and settle, and whether any stretch is dead.
For a fast entrance, add a second sheet of its first second at `fps=18`. Look at the sheet, fix, and re-render only when the
choreography changed.
