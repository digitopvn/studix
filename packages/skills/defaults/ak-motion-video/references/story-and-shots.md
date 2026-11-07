# Story and shots: the narrative layer

The style profile decides how the video looks; this file decides what it says
in which order and how each scene is framed. It sits before the script: pick an
arc, write the hook, size the scenes, then plan one shot language per scene so
adjacent scenes never move the same way. Adapted from the beat layer of
vox-director (MIT), translated from AI image-to-video to HTML + GSAP.

Three tiers, three levels of control:
- **Arc** (whole video): pick from the menu below by topic; record it as
  `"arc"` in `data/script.json`.
- **Scene copy and hook** (per scene): drafted from the facts; this beat map is
  shown to the user once before any paid audio is generated, and work continues
  unless they object.
- **Shot size and camera move** (per scene): derived from the arc position and
  the anti-monotony rule, from the closed vocabulary below. Free-form camera
  ideas go through the style's `camera` dimension, not here.

## 1. Narrative arcs

| Arc | Use for | Scene shape |
|---|---|---|
| `hook_payoff` | any single idea; the safe default | Hook → Context → Build → Payoff → Button |
| `pas` | pain-aware ads, urgency | Problem → Agitate → Solve → Proof → CTA |
| `bab` | when the "after" sells better than the pain | Before → After → Bridge → CTA |
| `aida` | cold-audience paid ads | Attention → Interest → Desire → Action |
| `storybrand` | brand or service, customer as hero | Hero wants → Problem → Guide → Plan → CTA → Stakes |
| `how_it_works` | product, process or system explainer | Hook → What it is → 2–3 shown steps → Benefit → CTA |
| `release_tour` | launch and changelog videos | Hook → Headline number → Feature × N (strongest first and last) → Stability/proof → Outro |
| `timeline` | history, "evolution of", journeys | Start → Event → Event → Turning point → Present → Takeaway |
| `man_in_hole` | case study, comeback, transformation | OK → Fall → Deepen → Climb out → Better than before |
| `story_spine` | mission, founder or brand tale | Once… → Every day… → Until one day… → Because… → Until finally… → Ever since… |
| `origin` | "why we exist" | World → Spark → Leap → Struggle → Breakthrough → Today |
| `myth_buster` | correcting a misconception | Fact first → The myth → Expose it → What to believe → CTA |
| `listicle` | tips, tools, rankings | Promise → Item → Item → … → #1 → Recap/CTA |
| `three_act` | any narrative piece | Setup → Confrontation → Resolution |

Topic heuristic: product ad → `pas`, `bab`, `aida` or `storybrand`; release or
changelog → `release_tour`; concept or system → `how_it_works` or `hook_payoff`;
history → `timeline`; transformation → `man_in_hole`; mission → `story_spine` or
`origin`; a wrong belief → `myth_buster`; ranking → `listicle`.

Arc stages map onto the style system's scene types (`style-system.md`): hook →
`hook` or `cover`, proof → `stats` or `testimonial`, steps → `feature`,
`ui-demo` or `diagram`, CTA → `cta`, the end → `outro`.

## 2. Hook, pacing and scene count

- **Hook within 3 s.** The first spoken line and the first on-screen words carry
  the promise. Never spend the cover on set-up. Pick one pattern and record it
  as `"hook"`: `mistake_callout`, `pain_point`, `surprising_stat`,
  `direct_question`, `urgent_warning`, `secret_reveal`, `experiment_story`,
  `pattern_interrupt`, `outcome_tease`.
- **Proportions:** hook 1–3 s, body 70–80%, payoff 10–20%, ending 0–2 s.
- **Scene count by duration** (VO at ~150 words per minute, TEMPO 1.08):

  | Duration | Scenes | Scene length | VO words |
  |---|---|---|---|
  | 30 s | 6–8 | 4–5 s | 70–80 |
  | 60 s | 10–12 | 5–6 s | 130–150 |
  | 140–150 s | 14–16 | 8–10 s, each with internal cuts | ~360 |

- **Something changes every 3–5 s.** A scene longer than ~7 s gets an internal
  cut-in (section 3); nothing holds unchanged past 8 s.
- **Endings**, recorded as `"ending"`: `hard_cut` (cut on the payoff; drives
  rewatches), `quick_cta` (≤ 2 s, one action plus its benefit in 3–5 words),
  `loop_close` (the last line mirrors the first so a loop replays seamlessly),
  `signature_outro` (the calm outro bed, plus the signature from
  `composition-contract.md` when the user supplied one; the default for releases).
- **Short candidates, picked while planning.** When the user will want vertical
  clips, mark them now as scene ranges in `data/shorts.json`. A candidate is
  20–60 s, opens on its own hook line, and makes one complete point without the
  scenes around it. The builders of those scenes then write the 9:16 overrides
  while they hold the context (`reframe.md`, "Shorts").

## 3. Shots

### Shot size

How much of the scene's world fills the 1920×1080 frame. In HTML it is the
camera group's scale and which layers are in view.

| Size | Frame | Job |
|---|---|---|
| `EST_WIDE` | the whole system or diagram | orient, show scale |
| `WIDE` | subject in its environment | set the scene |
| `MEDIUM` | one subject centred; the workhorse | explain |
| `CLOSE` | one detail fills the frame | emphasis, emotion |
| `DETAIL` | one number, word or texture | a punch moment |

Patterns across scenes: build intensity with `EST_WIDE → MEDIUM → CLOSE`;
reveal context with `CLOSE → WIDE` (a good ending).

**The cut-in** is the best two-shot scene: a `WIDE` that orients, then a cut on
a spoken keyword to a `CLOSE` of the key element. The voice runs continuously
across both; only the framing changes. In HTML it is one scene with two camera
states: a 0.35–0.5 s `expo.inOut` scale and translate of the camera group onto
the element at `W(sid, "keyword")`, or a hard cut to a pre-built close layer
on a beat. Use it for any scene longer than ~7 s.

### Camera move

One move per shot, applied to the scene's camera group (never to individual
text). Uniform translate and uniform scale keep type crisp and aligned.

| Move | GSAP on the camera group | Job |
|---|---|---|
| `static` | no transform beyond `settleCam` micro-motion | let a stat or quote land |
| `push_in` | scale 1.00 → 1.06–1.12, `power2.inOut` over the hold | tension, focus |
| `pull_out` | scale 1.12 → 1.00, reveals more layers | big picture, reveal |
| `pan` | `x` across a stage wider than the frame | read a list or timeline |
| `tilt` | `y` across a tall stage | reveal scale, a countdown |
| `parallax` | bg / mid / fg move at ≈ 0.3 : 1 : 1.6 | the living, layered look |
| `element` | camera still; one element slides or hinges in | introduce one item |

Bold moves, used only when the base profile's `camera` allows them and the
moment earns it: `orbit` (CSS 3D `rotationY` on a perspective group), `roll`
(a few degrees of `rotation`), `whip` (see whip pan in `motion-craft.md`),
`dolly_zoom` (scale the background up while the subject scales down). They are a
style choice, not forbidden; a profile constraint such as "locked-off" always
wins.

### Anti-monotony

The biggest single quality lever. Scenes of one style look alike, so the camera
must not repeat:
- No two adjacent scenes use the same move.
- The base profile's `camera` dimension bounds the vocabulary. Under a
  locked-off base, use only the moves its `camera` line names, fill the other
  scenes with `element`, and keep `static` for the payoff.
- Prefer alternating families: scale (`push_in`, `pull_out`) ↔ translate
  (`pan`, `tilt`, `parallax`) ↔ `static`. Two different translate moves may sit
  together when the arc travels (a timeline, a tour of panels).
- Reserve `static` for the payoff, quote or headline number, so the motion drop
  itself says "this is the point".

Move rhythms per arc:
- `hook_payoff` (8): push_in → pan → parallax → static → push_in → tilt → pull_out → static
- `pas` / `bab` (6): push_in → static → pan → parallax → push_in → static
- `release_tour`: alternate push_in and parallax across features; static on the
  headline number; pull_out into the outro
- `listicle`: parallax on #1, then pan and push_in alternating across items
  (flip the pan direction each time), static on the recap
- `timeline`: pan and parallax alternating, both travelling in one direction
  (moving through time), push_in on the turning point, pull_out on the takeaway

### Element motion

Camera and element motion are independent axes. One camera move per shot plus
as much element motion as the energy budget in `motion-craft.md` allows. A
`WIDE` moves several elements a little; a `CLOSE` moves its one subject
strongly. A hero element crossing the whole frame (a paper plane, a coin, an
arrow, a cursor) is a strong punch on a key scene, not on every scene; one in
every scene reads as a formula.

## 4. Recording it

Optional fields in `data/script.json` (the pipeline scripts ignore them; the
direction brief and the composition read them):

```json
{
  "arc": "release_tour", "hook": "surprising_stat", "ending": "signature_outro",
  "scenes": [
    { "id": "s01-cover", "type": "cover",
      "shot": { "size": "WIDE", "camera": "push_in", "cutIn": { "word": "three", "size": "CLOSE" } },
      "lines": [ ... ] }
  ]
}
```

Vocabulary, for copy and paste:

```text
ARCS:    hook_payoff pas bab aida storybrand how_it_works release_tour timeline
         man_in_hole story_spine origin myth_buster listicle three_act
HOOKS:   mistake_callout pain_point surprising_stat direct_question urgent_warning
         secret_reveal experiment_story pattern_interrupt outcome_tease
SIZES:   EST_WIDE WIDE MEDIUM CLOSE DETAIL
MOVES:   static push_in pull_out pan tilt parallax element  (bold: orbit roll whip dolly_zoom)
ENDINGS: hard_cut quick_cta loop_close signature_outro
```
