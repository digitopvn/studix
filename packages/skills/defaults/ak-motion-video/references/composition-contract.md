# Composition contract

Rules every `index.html` follows, independent of the visual style. The skeleton
at `assets/templates/index-skeleton.html` implements all of them.

## HyperFrames runtime

- Root: `<div id="root" data-composition-id="main" data-start="0" data-duration="N"
  data-width="1920" data-height="1080">`. Layout reads the frame from `--W`/`--H`
  and `<html data-ratio>`, which `scripts/reframe.py` rewrites for 1:1 and 9:16
  editions (`reframe.md`). `build-timeline.mjs` rewrites
  `data-duration` on `#root` and `#mix` from `DURATION`.
- One paused GSAP timeline registered as `window.__timelines["main"]`; the
  renderer seeks it frame by frame. End with `tl.set({}, {}, T.duration)` so the
  timeline length equals the video length.
- Audio is one element: `<audio id="mix" src="./assets/audio/mix.m4a" data-start="0"
  data-duration="N" data-track-index="10" data-volume="1">`. Never let the page
  play separate VO/SFX files; the ffmpeg mix is the single source of sound.
- GSAP from `cdn.jsdelivr.net/npm/gsap@3.14.2`; fonts as local TTF files with
  `font-display: block`. When a style's font is not available locally, use the
  closest local font of the same class (grotesk, serif, mono), keep the real
  italic or a second weight for accents, and tell the user which font replaced
  which.
- Without a voice-over there is no `build-timeline.mjs` run: write TIMING by
  hand in the same shape (`captions`, `sfx` and `env` may be empty), paste it
  between the markers and set `data-duration` yourself.

## Determinism

- All times come from `window.TIMING` (injected between `/*TIMING:BEGIN*/` and
  `/*TIMING:END*/`). No `Date`, no `requestAnimationFrame`, no CSS animations or
  transitions: only timeline tweens.
- Randomness only through the seeded `rng(seed)` helper.
- Never schedule a tween before 0 (`W(sid, word) - 0.1` in the first scene can
  be negative): GSAP then shifts the whole timeline later and it drifts from the
  audio. Clamp with `Math.max(0, ...)`; `slam` already does.
- Shared layers that several tweens animate (flash, wipes) use `fromTo` with
  explicit values, so overlapping tweens render the same frame whatever order
  the renderer seeks in.
- Build all DOM synchronously before the first tween (mascots, word spans,
  generated rows, SVG nodes). Nothing is created during playback.
- Use `immediateRender: false` on `fromTo` tweens that reuse a shared layer
  (flash, wipe, dots, speed lines, RGB offsets); otherwise the first tween's
  start state leaks to time 0.

## TIMING shape

```text
duration, fps, beat0, beatLen, kick[[from,to)], drops[beat], outroBeat,
scenes{ id: { start, end, lines[{ on, off, words[[word, start, end]] }] } },
captions[{ start, end, words[[text, start]] }], sfx[{ sfx, vol, t }], env[frame] (0..1)
```

Words are lower-cased with punctuation stripped (`"let's"`, `"v334"`), so look
them up that way.

### `data/timeline.json`

`timeline.json` is the TIMING above without `env`. The recording mode adds
`"mode": "recording"`. All times are absolute seconds in the master.

| Key | Shape |
|---|---|
| `scenes.<sid>` | `{ start, end, lines: [{ on, off, words: [[word, start, end]] }] }` in script order |
| `captions[i]` | `{ start, end, words: [[text, start]] }`, ≤ 9 words each, never across a scene end |
| `sfx[i]` | `{ sfx, vol, t }` |
| `beat0`, `beatLen`, `kick`, `drops`, `outroBeat` | the beat grid; `kick` and `drops` are beat numbers |

A long video's timeline runs to 100k lines. Builders never read it raw; they
query it instead:

```bash
python -X utf8 <skill>/scripts/tl.py <project> scene s012      # absolute and part-relative window, lines, word times, neighbours
python -X utf8 <skill>/scripts/tl.py <project> words s012 "token|cache"
python -X utf8 <skill>/scripts/tl.py <project> short 03
```

A part or short build (`assemble.py`) writes its own `builds/<tag>/timeline.json`,
rebased so that the build starts at 0.

## Scene fragments and shell markers

Builders write one file per scene, `scenes/<sid>.scene.html`. It holds the
scene's `<section>`, one `<style>` scoped under the section id, and one
`<script>` with the choreography body. `scripts/scaffold-scenes.py` writes the
stubs. `scripts/assemble.py` splices the fragments into the shell between these
markers in the skeleton:

- `<!--SCENES:BEGIN-->` and `<!--SCENES:END-->` in `#stage`.
- `/*SCENE-CSS:BEGIN*/` and `/*SCENE-CSS:END*/` in the main `<style>`.
- `/*SCENE-JS:BEGIN*/` and `/*SCENE-JS:END*/` in the main script, after the
  helpers and `WINDOWS`. Each body runs in its own block with `sid` set, and
  only when that scene is in the build.

`WINDOWS` rows for scenes outside a build are skipped, so a part or a short
reuses the full table. The legacy triple (`<sid>.html`, `.css` and `.js`)
still assembles.

## Known pitfalls

These are failures that `check` or the renderer found late in real runs:

- `ease: "none"` is a string. A bare `none` throws
  `ReferenceError: none is not defined` and blanks the whole timeline.
- Keep exactly one root HTML file in a build directory. A stray `debug.html` or
  `test.html` fails `check` with `multiple_root_compositions`. Keep scratch
  pages out of `builds/` and the project root.
- Mark intentional overlap (stacked cards, a mascot over a panel, a label on a
  chart) with `data-layout-allow-overlap` on the overlapping element, and
  intentional clipping with `data-layout-allow-overflow`. Fix every other
  overlap.
- Contrast is measured against the actual background. On a light paper
  background, take text colours only from the style's tokens that already pass
  4.5:1. Record them in the plan once, for example
  `--ink, --ink-2, --accent-dark`. A token at 4.36:1 fails. Never lighten text
  to make it look softer.
- Compute absolute positions in the offset parent's frame. An element placed
  with `left/top` inside a transformed or positioned card is measured from that
  card, not from the frame, and a 9:16 override then misses by the card's
  offset. Read `offsetParent` before positioning.
- GSAP prints an `autoRound` warning for some transforms. It is known and
  harmless, so do not "fix" it.
- Validate a few scenes at a time (`assemble.py --scenes a..b --tag tmp` then
  `validate.py`), not after a whole part. Twenty layout errors found at the end
  cost a second pass through scenes that have left everyone's context.

## Helpers

| Helper | Use |
|---|---|
| `B(n)` | time of quarter note n |
| `isKick(n)` | beat n is inside a full-beat range; scale reactions by it |
| `W(sid, word, nth)` / `WE(...)` | onset / end of a spoken word; warns and falls back to scene start when missing |
| `envKeys(el, t0, t1, step, map)` | keyframes from the voice envelope (mouths, waveforms, meters) |
| `pop`, `rise`, `slideX`, `flipIn`, `draw`, `typeIn`, `bump`, `fadeOut` | entrance vocabulary shared by every style |
| `odo(el, t)` | digit reels roll into `<span class="odo" data-value="40%">` |
| `slam`, `smear`, `lineIn`, `settleCam` | juicy entrances and hold motion (`motion-craft.md`); `slam(el, t, { soft: true })` for energy 3 |
| `flash`, `shake` | cut/drop punctuation on shared layers; `shake` is seeded, decays, and is for energy 4–5 |

Choreograph with word anchors: "the chip appears on the word *OAuth*", not
"0.8 s after the scene starts". Re-timing the voice then moves visuals with it.

## Scene windows

A `WINDOWS` table lists `[selector, scene id, transition, ...style fields]`. One
loop turns it into: transition in at the scene start, transition out just before
the next scene start (the out-transition matches the next window's kind), a
flash/speed accent on cuts scaled by `isKick`, and `intro(sc, t0)` for the
scene's headline. Scene starts come from `TIMING.scenes`, which already sit on
beats. Big moments (`TIMING.drops`) get their own flash + shake.

## Beat reactions

Loop `n` over beats until `outroBeat`; on kick beats pulse a background layer
(orbs or halftone), on kick downbeats scale a `#pulse` wrapper by ~1%. Keep it
subtle: reactions are texture, cuts and drops carry the rhythm.

## Captions

- Vietnamese karaoke: one `.cap` per caption chunk (≤ 9 words, split at
  punctuation), each word a span that highlights at its borrowed English onset.
- Bottom band only; with a signature, the width stops left of it (1660 px of
  1920 in the comic edition). Nothing else may live in that band: `check` will flag overlap.

## Mascot and HUD

- Mascot is inline SVG built by a `mascot(uid, accessory)` function with
  `.m-move` (position), `.m-squash` (squash/stretch from the feet), `.m-face`
  (fake head turn by sliding the face), `.m-eyes`, `.m-pupils`, `.m-mouth`.
  Accessories per scene (headphones, cape, glasses) make it reusable.
- Talking = `envKeys` on `.m-mouth` scaleY between line on/off.
- A HUD counter (feature n / 12 + progress segments) runs from the first
  feature scene to the last and hides for cover and outro.

## Renderer limits

- More than ~40 elements with `radial-gradient`, `filter: blur()` or
  `clip-path` on screen produced black frames. Bake textures (halftone dots,
  grain, graffiti, distress) into PNG tiles under the project's `assets/images/` and use them as
  `background-image` or `mask-image`.
- Attach SVG filters (RGB split) only while an effect runs: `tl.set(el, { filter:
  "url(#rgb)" })` and back to `none` a few frames later.
- `visibility` toggles are cheaper than `opacity: 0` for heavy full-frame layers
  (halftone wipes).
- Keep `index.html` in one file unless it gets unwieldy. Lint warns above 300
  lines not counting `<style>` (`composition_file_too_large`); a full video
  always passes that and renders fine, so treat the warning as expected. The
  references are 1332 and 1636 lines.
- `check` reports text clipped by `overflow: hidden` (line masks, reels,
  sweeps) as overflow. Mark intentional clipping with
  `data-layout-allow-overflow` on the mask; the skeleton does it for `.odo`.

## Signature

Optional, and there is no default text. Add one only when the user supplies it
(a name, handle or mark they own); otherwise leave `#sig-txt` empty and the
skeleton removes the block. When present: handwritten text bottom-right from
1.0 s to the end, revealed with a stepped `clipPath`, underline drawn with
`strokeDashoffset`. Style it to match the video (marker font with
misregistration for comic).
