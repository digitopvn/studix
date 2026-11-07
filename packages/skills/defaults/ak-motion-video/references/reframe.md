# Reframe: 1:1 and 9:16 editions

A square or vertical edition reuses everything the 16:9 master already paid
for: voice-over, alignment, music arrangement, TIMING, mix and captions. Only
the frame size and the layout change, so an edition costs one CSS block and one
render, not a new project.

| Ratio | Frame | Typical target |
|---|---|---|
| `16x9` (master) | 1920×1080 | YouTube, X, website |
| `1x1` | 1080×1080 | feed posts, LinkedIn |
| `9x16` | 1080×1920 | Reels, TikTok, Shorts, Stories |

## Pick the route

| Route | Cost | Result | Use when |
|---|---|---|---|
| **Full-video edition** (`reframe.py`) | one CSS block per ratio and a render of the whole video | the same video, re-laid out for the frame | a square or vertical copy of the whole piece |
| **Shorts** (scene-range clips, `assemble.py` through `shorts.py`) | overrides only for the short's scenes, one short render each | 20–60 s vertical clips cut from the master with their own HUD title and a music tail | Reels, TikTok and Shorts cut from a long video, above all a recording-driven one |
| **Quick fit** (ffmpeg only) | one command, no authoring | 16:9 picture inside a blurred fill, or a centre crop | previews, internal review, or when the user accepts small text |

Default to a layout route for publishing. Offer the quick fit when speed
matters more than finish, and say which one you used. Plan either layout route
while the master is being built, not afterwards. When the 16:9 builders write
the `html[data-ratio]` overrides for their own scenes while they hold the
context, the costly second pass disappears. In one real run, six fresh
re-layout builders re-read the brief, the contract and 105 scenes, at ~140 M
tokens and ~45 minutes. Nothing is rendered in another ratio until the user
approves the master.

## Re-layout

### 1. Keep the master ratio-aware (cheap when done from the start)

The skeleton already does most of this; keep it that way while authoring:
- Size frames from `--W`/`--H` (`#root`, `.layer`), never literal 1920/1080.
- Put layout in CSS classes, not inline styles or JS. Tween with relative
  values (`xPercent`, `yPercent`, `scale`) instead of pixel offsets tied to
  1920 px.
- Lay scenes out with flex or grid inside a stage, so most of them reflow
  without overrides.
- Keep captions and the signature on their CSS variables (`--cap-w`,
  `--cap-bottom`, `--cap-size`); the skeleton sets values for each ratio.

### 2. Write the ratio overrides in the master

Add `html[data-ratio="9x16"] ...` (or `"1x1"`) rules to the master's `<style>`.
Only override what breaks, scene by scene:
- **Side-by-side becomes stacked.** Two-column feature layouts turn into a
  column: `flex-direction: column`, the visual on top and the text below.
- **Type scales to the width.** In 9:16 headlines are ~80–96 px across a
  900 px measure; in 1:1 ~72–88 px.
- **Safe areas.** Vertical social apps cover the top ~220 px and bottom
  ~420 px, plus ~140 px on the right edge. Keep text and faces inside
  1080×1280 starting at y=220. Captions go to `--cap-bottom: 440px`.
  The webcam-PiP layout of a recording-driven video has different numbers,
  verified on a 10-short run:

  | Zone | 9:16 frame (1080×1920) |
  |---|---|
  | Content (text, UI, diagrams) | x 72–1008, y 250–1250 |
  | Webcam PiP | centre (196, 1380), Ø 240; keep content out of it |
  | Captions | x 340–980, ending at y ≤ 1490 |
  | HUD (short title, counter) | y ≈ 176 |
  | Minimum type | 24 px |

  `scripts/check-bounds.mjs` uses these numbers by default for 9:16. Override
  them with `--safe <file.json>` for another layout.
- **Wide content.** Tables, timelines and diagrams wider than the frame become
  vertical, lose columns, or scale down with one hero element enlarged.
- Transitions that move along x (whip, smear) can stay; check that their
  travel distance uses `--W` or `xPercent`.

### Audit the overrides before committing

Every rule added for a ratio has to sit under `html[data-ratio=…]`, no 16:9 CSS
may be removed or changed, and every JS change must be gated by the ratio flag.
Otherwise the master regresses while the edition is fixed.

```bash
python -X utf8 <skill>/scripts/audit-ratio-scope.py <project> --ratio 9x16     # required before each commit of overrides
```

It diffs against `HEAD` with `--ignore-cr-at-eol` and strips CSS comments
before reading selectors, so Windows line endings and commented-out examples
cause no false alarms.

### 3. Generate the edition

```bash
python <skill>/scripts/reframe.py . --ratio 9x16     # writes ../<slug>-9x16/
python <skill>/scripts/reframe.py . --ratio 1x1      # writes ../<slug>-1x1/
```

The script copies `index.html` with the new root size, viewport, `data-ratio`
and `--W`/`--H`, copies `hyperframes.json`, and hard-links `assets/` and
`compositions/` (copies when hard links are unavailable), so it takes no extra
disk and seconds to run. Sub-compositions under `compositions/` are not
rewritten or checked: size them from `--W`/`--H` too. A hard-linked file is the
master's file, so editing it inside the edition changes the master. Its warnings point to what still needs attention: a missing
`data-ratio` block, a layout that ignores `--W`/`--H`, or the line numbers of
remaining 1920/1080/960/540 pixel values. Read those lines instead of the
whole file.

The edition directory is derived output. Never edit it: change the master and
run the script again, which replaces the edition. The script refuses to write
into a directory it did not create, and the master's TIMING must already be
injected.

### 4. Validate and render inside the edition

```bash
cd ../<slug>-9x16
npx --yes hyperframes@0.8.77 lint
npx --yes hyperframes@0.8.77 check
npx --yes hyperframes@0.8.77 snapshot --at <one busy moment per scene> --describe false
npx --yes hyperframes@0.8.77 render -q high -f 30 --strict -o ../<slug>/renders/<slug>-9x16-raw.mp4
ffmpeg -y -i ../<slug>/renders/<slug>-9x16-raw.mp4 -i ./assets/audio/mix.m4a -map 0:v:0 -map 1:a:0 -c copy -movflags +faststart ../<slug>/renders/<slug>-9x16.mp4
```

Write renders into the master's `renders/`: the edition directory is replaced
on every run of the script, so anything saved inside it is lost. The
`../<slug>/renders` path assumes the default edition location next to the
master; with `--out`, use the master's absolute `renders/` path.

Downscale snapshots before viewing them, or check a contact sheet
(`motion-craft.md`). The remux, loudness and blackdetect checks are the same as
for the master (`production-pipeline.md` step 8), with the edition's frame size
in the ffprobe check. The social encode is step 9 unchanged.

## Shorts: scene-range clips

A short is a run of the master's scenes: `[{ "id": "01", "title": "…", "scenes": "s012..s018" }]`
in `data/shorts.json`, chosen from the transcript while planning
(`recording-pipeline.md`, step 6). It works in both modes.

```bash
python -X utf8 <skill>/assets/templates/recording/shorts.py . build    # assemble.py --ratio 9x16 --title … --tail 1.2 --fade 1.2 per short
for d in builds/short-*; do node <skill>/scripts/check-bounds.mjs "$d"; python -X utf8 <skill>/scripts/validate.py "$d"; done
python -X utf8 <skill>/assets/templates/recording/shorts.py . render   # one render at a time, then finish.py (webcam PiP, untouched audio)
python -X utf8 <skill>/assets/templates/recording/shorts.py . probe    # 1080×1920, 30 fps, loudness, blackdetect
```

Each short build is rebased to start at 0. It has the audio slice of its
scenes, its captions window, a HUD title from the short's `title`, and a 1.2 s
music tail with a fade, taken from the mix stems. Review one contact sheet per
short (`scripts/contact-sheet.py renders/shorts/<id>.mp4 --timeline builds/short-<id>/timeline.json`).
In the run that shaped this route, the sheets caught all 7 overflowing scenes
of one short, and `check-bounds.mjs` caught an end drawing that never finished.

## Quick fit (ffmpeg only)

From the finished master, with no authoring:

```bash
# 9:16: master centred on a blurred, darkened fill of itself
ffmpeg -y -i renders/<slug>.mp4 -filter_complex \
  "[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=40,eq=brightness=-0.12[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]" \
  -map "[v]" -map 0:a -c:v libx264 -crf 20 -preset slow -c:a copy -movflags +faststart renders/<slug>-9x16-fit.mp4

# 1:1: centre crop (only when every scene keeps its content inside the middle 1080 px)
ffmpeg -y -i renders/<slug>.mp4 -vf "crop=ih:ih:(iw-ih)/2:0,format=yuv420p" \
  -map 0:v -map 0:a -c:v libx264 -crf 20 -preset slow -c:a copy -movflags +faststart renders/<slug>-1x1-crop.mp4
```

The fit version keeps everything but shows text at 56% of its size; the crop
cuts anything outside the centre column, including the caption edges and the
signature. Say so when you deliver either one.
