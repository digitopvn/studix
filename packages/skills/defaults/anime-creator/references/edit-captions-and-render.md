# Edit, live captions and render

One `edl.json` per scene is the single source of timing. The GL bundle, the HyperFrames page, captions,
subtitles, conform, the mixer and the grade all read it; changing a cut means editing one file and
rebuilding, never re-timing five places by hand.

## EDL

Template: `assets/film-engine/scene-template/edl.json`.

| Field | Meaning |
|---|---|
| `fps`, `duration`, `width`, `height` | duration and every start/end on whole frames (validate rejects 4.6s at 24fps) |
| `shots[]` | contiguous, `id`, `kind` (`gl`, `video`, `cel`), `start`, `end`, `tier`, `beat` |
| video shot | `src` (relative to the episode dir), `in` (seconds into src), `speed`, `audio` (keep its sound) |
| gl shot | `set` (id in scene-config.js) |
| cel shot | `img` (relative to the scene dir) |
| `dialogue[]` on a shot | `speaker`, `t0`, `t1` (edit time), `text` (spoken), `tr` (translation), `words[]` (from alignment) |
| `speakers` | name and caption colour per speaker id |
| `title`, `fade`, `captions`, `hits` | title card time, fades, caption highlight and hold, hit times for the grade |

`anime-studio.py validate <scene-dir...>` before every build: contiguity, frame alignment, at least 2 frames
per shot, required fields per kind, dialogue inside its shot and the film, word order, missing clips. It
also warns on holds over 8s and on shots without a tier. `build` and `build-edit` refuse an invalid EDL.

## Cutting craft

- Cut on action: end the outgoing shot mid-motion, start the next on the continuation. A 1-2 frame whip
  pan between angles is a transition, not a defect (a QA model flagged one as "blurred").
- 180-degree rule within a scene; reverse shots mirror screen positions (hero at the right third, reverse
  at the left third).
- Action shots 0.6-1.5s, acting shots 2-4s, an establishing beat up to ~2s with a camera move. A beat that
  needs more is two shots.
- Measured rhythm of eight action references (`measure-reference-cut.py`, micro cuts of 3 frames or fewer
  counted apart): mean shot length 0.78-1.33 s, median 0.40-1.00 s, 44-77 cuts a minute, 48-75% of shots
  under 1 s and 0-13% over 3 s. The one exception is a 30 s long take (16 shots,
  ASL 1.84 s) that changes angle through full-frame FX wipes instead of cuts. FRONTIER ep02 measured ASL
  2.33 s, median 1.88 s, 25 cuts a minute and 28% of shots over 3 s: an action sequence of ours should sit
  inside the reference band, a dialogue scene may not.
- Compare against a reference before the edit locks, on the same span lengths:
  `measure-reference-cut.py <ref.mp4> <ours.mp4>@t0-t1 --sheet work/ref-sheets --json work/cut-compare.json`.
  Read the shot sheet next to the numbers: the detector misses dissolves and can split one shot at a heavy
  FX change.
- Breathe after the climax: a slower shot or a held cel before the title.
- A fall needs anticipation and a cushion (a catch, a slow-down, a cut on the drop). An abrupt fall was one
  of the four defects left in the xianxia v1.
- Let sound lead picture by a few frames on a cut (J-cut) when a line or a hit starts the next shot.
- AI clips hide internal cuts. Never let a shot's used range (`in` to `in + length * speed`) span one, and
  never reuse a clip's internal cut across a shot boundary; `qa-prescan.py clips <scene>` lists them.

## Edit correctness (each rule cost a QA round on FRONTIER)

- **Frame grid.** Write every cut and cue time as a whole frame, floored at 6 decimals:
  `math.floor(t * fps + 1e-9) / fps`, then `round(x, 6)`. Rounding to 4 decimals made 50.1667 land after
  frame 1204, so every layer showed the outgoing shot one frame late; flooring at 4 decimals then failed
  `validate`.
- **Speed.** Change speed only by interpolation (`minterpolate` in conform), or keep 1.0. Frame duplication at
  0.9x judders. A source drawn on twos still judders after interpolation: mark it `"twos": true` so conform
  keeps the even frames first.
- **Tweened cards.** Give every tweened element an explicit initial `tl.set` before a delayed `fromTo` with
  `immediateRender: false`, or it pops in at its end state. Name and end cards popped this way.
- **Transforms.** `show()` overwrites `transform`, so a `matrix3d` corner-pin or a scale on the same element is
  lost. Put the transform on a wrapper and tween the child. GSAP has no `className`; use `attr: {class}`.
- **CSS.** Scope card styles under the card's id. A bare `.tag` rule leaked into a name card.
- **Screens and glass.** Check the mirror direction of any text on glass or a screen seen from behind;
  "chữ trên không trung viết ngược" (text in the air written backwards) was a user note.

## Episode recap (OST music video)

A 30-40 s part after the ending card, cut to the series' own song (never a regeneration):
- One continuous song window, or a transient-to-transient splice. Pick it by lyrics that land on the episode's
  beats, and avoid the section the ending card already plays. End on a real downbeat with the title hit
  (layered impact).
- Beat grid from the song itself (tempo drifts). Cut on the kick frame, denser at the drop, no still held over
  1.5 s, and picture only from approved, shipped takes.
- Karaoke lines from vocal onsets measured on the vocals stem, the first word included (QA caught one 0.26 s
  late). The song's own words, checked against the lyrics file.
- Open with name cards for characters new in the episode, else a kinetic "episode NN recap" label.
- The music bus is exempt from the dialogue duck; push hits about +4 dB and check the drop still punches over
  the chorus.
- Split screens fill every pane on entry (a tinted plate, never black); typed or read text holds complete for
  at least 1 s before the next cut.
Reference build: FRONTIER `ep02/work/scene-build/rc/` (`make-rc-plan.py`, `encode-rc.py`).

## Captions (live, DOM)

Captions are DOM overlays generated from the EDL by `edit/captions-from-edl.js`: spoken line plus
translation, speaker colour, one span per word for a karaoke highlight when `words` exist.

- Word timings come from the `align` job (ElevenLabs forced alignment); the runner writes them into the
  EDL line when the job has `scene`, `shot` and `line`.
- Fonts: CJK in a serif or Hiragino face (Songti SC worked for zh), Latin and Vietnamese in Be Vietnam Pro
  (downloaded by init-scene unless `--offline`). At 1080p: at least 38px with a 5px stroke and
  `paint-order: stroke` for the spoken line; a smaller caption was a user complaint.
- Keep captions inside the title-safe area and away from the action's focal point: never over a mouth, hands
  or screen UI. Lift a line with `cap_bottom` (px from the frame bottom, on the dialogue line) or a
  `tl.set("#cap-…", {bottom})` cue rather than moving the picture. HyperFrames `check` flags low contrast (4.5:1 or more).
- The karaoke highlight must differ from the base caption colour by a ΔE of 40 or more; a highlight at ΔE 19
  read as no highlight.
- `anime-studio.py subtitles <episode> --format srt|vtt --which spoken|tr|both [--out ep01-cut3.en]` exports
  sidecar subtitles for upload platforms. Without `--out` it writes `renders/<episode>.<fmt>` and overwrites
  that file on every export, so name one file per cut and language.
- A cue starts on its first aligned word and ends with its shot's cut. Early-popping captions and captions
  hanging over the next shot were both user notes.

## Build, check, render

```bash
python3 scripts/anime-studio.py conform <scene>       # clips/<shot>.mp4 and .wav, exact frame counts
python3 scripts/anime-studio.py build <scene>         # validate + GL bundle (esbuild) + index.html
python3 scripts/anime-studio.py build-edit <scene>    # index.html only (template, CSS, fonts); the bundle embeds edl.json, so any EDL change needs build
python3 scripts/anime-studio.py render <scene> --quality draft
python3 scripts/anime-studio.py snapshot <scene> 2.6 out.png
```

- `--duration 4.6` on build and build-edit makes a short slice for fast iteration (about 1 minute to render
  versus 5.5 minutes for 15.7s draft).
- `render` runs `hyperframes check` first; the template lives in `src/` because a template HTML at the
  project root made `check` fail with `multiple_root_compositions`.
- Workers default to the preflight suggestion (memory and load aware, 1 when the machine is overloaded).
- `draft` for review, `delivery` for the master. Draft bitrate is too low to grade from.
- HyperFrames is pinned (0.8.77 in the measured runs) and renders png frames
  (`--video-frame-format png`) so additive light is not banded.
- One heavy job at a time: a grade and a render fighting for the CPU made both slower than running them in
  sequence, and pushed a tool call past its timeout.
- Episodes: `anime-studio.py concat <episode>` joins scene renders in episode.json order. For deliverables,
  use `assemble-episode.py` (below), which also encodes the audio true-peak-safe.

### Bundle, render, finish (long scenes and episodes)

`render` does not bundle. It renders whatever `dist/film.js` already holds. `build` bundles but also
regenerates `index.html`, which destroys a hand-edited page. Stale bundles cost FRONTIER two failed rounds:
a missing decal, and a `followCel is not a function` crash.

```bash
NODE_OPTIONS=--max-old-space-size=8192   # finish-scenes sets this; the 4 GB default died with exit 134
python -X utf8 scripts/finish-scenes.py <ep> --scenes sc01,sc02,sc03 --tag "{sc}-cut3-r1"            # full render
python -X utf8 scripts/finish-scenes.py <ep> --scenes sc03 --tag "{sc}-cut3-r2" --video-from "{sc}-cut3-r1"  # new mix only
python -X utf8 scripts/assemble-episode.py <ep> --name ep01-cut3 --tag "{sc}-cut3-r1" --part sc03=sc03-cut3-r2
```

`finish-scenes.py` handles one scene at a time, in order:

1. Compares the series engine with the skill's copy.
2. Runs `engine/build-scene.sh`.
3. Refuses a bundle older than its sources or `edl.json`.
4. Runs `validate`, then `render`, then `grade --mix`.
5. Writes the 720p review master and the share copy.
6. Measures every file into `renders/deliveries.jsonl`.

Some rules the script enforces:

- It refuses a tag that already has outputs, so reviewed takes survive.
- Renders run strictly in sequence. Two at once doubled the time and risked running out of memory.
- Measured draft renders take 4-7 min per 59-85 s scene, about half an hour for five scenes. Tell the user
  before starting.
- An audio-only fix never re-renders. `--video-from` remuxes the new mix under the old picture in about a
  minute, against about 17 minutes of renders.
- Run the background job with `set -o pipefail`, or without a pipe. A `| tee` once hid exit 127, and an old
  `index.html` was rendered.

### Fades and the first frame

The boot already fades in from black using `EDL.fade.in` (default 0.35 s). An extra `kit.fadeFromBlack()`
in `edit-cues.js` stacks on it and holds frame 0 black too long. Set `fade.in` in the EDL and never call
`fadeFromBlack` in cues. `qa-prescan.py picture` flags a leading black run longer than 0.5 s.

## Studio preview

`npx -y hyperframes@<pin> preview <scene-dir> --port=<fixed port> --foreground --no-open`, started through
the host's preview tooling with a launch entry. Studio plays without the mix and the grade, so colours look
flatter than the preview file. Use a fixed port per project, and stop the server when the user is done.

## Delivery sizes

Master (crf 14, grain) runs 110-155MB for 15-17s at 1080p. Chat file transfer caps at 30MB, so every
master ships with a two-pass preview (`grade --preview-mb 25`).

For an episode, the deliverables and their limits are:

| File | Use | Size (FRONTIER EP01 cut 3, 7.6 min) |
|---|---|---|
| `<name>-master.mp4` | 1080p archive; upscale and final only after approval | 2.4 GB |
| `<name>-master-720p.mp4` | the review master that the user watches first | 481 MB |
| `<name>-share-720p.mp4` | crf 27 picture, audio copied | 123 MB |
| `<name>-phone-540p.mp4` | chat and phone viewers, 2-pass to 28 MiB | 30 MiB hard limit; a 30.1 MiB file was refused |

- Review at 720p and upscale only after the user approves.
- Send each deliverable as soon as it exists, with its path and size.
- Do not send `grade`'s `-preview.mp4` for an episode. Its AAC is re-encoded from the master and can exceed
  the true-peak ceiling.
