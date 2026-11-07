# Verify loop — freeze frame, contact-sheet, probe MP4

Motion renders lie. A skill can output a "1080×1920 @30 h264 MP4" and hand
back a 720p 24fps VP9 file. A GSAP page can render, then paint garbage two
seconds later. The verify loop closes that gap: freeze the moment, tile
start / mid / end, probe the encoded file's real spec.

The three helpers in `scripts/` are copied verbatim from
[iart-ai/motion-skills](https://github.com/iart-ai/motion-skills) `master` @
`945c4c7`, `tools/verify/`, and packaged with executable mode (755).

## Requirements

| Helper | Depends on | Install |
|---|---|---|
| `probe-mp4.sh` | `ffprobe` (ships with `ffmpeg`) | `apt install ffmpeg` / `brew install ffmpeg` |
| `contact-sheet.sh` | `ffmpeg` | same as above |
| `seek-shot.sh` | `npx` + Playwright Chromium | `npx playwright install chromium` (once) |

## Tier selection

### Light tier — standalone HTML

Applies to web-animation, kinetic-typography, motion-design (web outputs),
generative-illustration, and any in-repo skill that renders a standalone HTML
harness (e.g. `ak-threejs`, `ak-shader`, `ak-frontend-design`).

Convention: the page pauses its timeline and calls `.seek(t)` when opened with
`?t=<seconds>` in the URL. `seek-shot.sh` drives that harness with a headless
Chromium and screenshots each frozen moment.

```bash
# Freeze at t=0, 1.5s, 3s (defaults if no times given):
scripts/seek-shot.sh anim.html 0 1.5 3

# Tile the frames side-by-side for one-glance review:
scripts/contact-sheet.sh sheet.png frame-*.png
```

Inspect `sheet.png`: does the hook read? Do start / mid / end look right? Any
clipped text, off-canvas element, FOUC, or bad loop seam?

**Caveat:** `seek-shot.sh` only produces meaningful stills when the page
implements the `?t=N` seek harness. External packs (web-animation,
kinetic-typography) build their outputs that way by default. In-repo
`ak-frontend-design` or `ak-threejs` output does not always — add the harness
first (a one-line `GSAP.timeline().pause(); tl.seek(new URL(location).searchParams.get('t'))`
or the Three.js equivalent) before running the shot.

### Heavy tier — encoded MP4 (Remotion / Manim / HyperFrames)

Applies to `ak-remotion`, `ak-hyperframes`, `ak-media-processing`, and every
external pack that ends in an MP4 (tiktok / youtube / ad / ecommerce /
data-animation / explainer / map / manim).

Two-step: render stills with the same props the video will ship, then encode
and probe the file.

```bash
# Remotion — render stills, tile, encode, probe:
npx remotion still Short out/f-hook.png --frame=10 --props='{...}'
npx remotion still Short out/f-mid.png  --frame=N  --props='{...}'
npx remotion still Short out/f-end.png  --frame=L  --props='{...}'
scripts/contact-sheet.sh sheet.png out/f-hook.png out/f-mid.png out/f-end.png
npx remotion render Short out/short.mp4 --props='{...}'
scripts/probe-mp4.sh out/short.mp4 1080x1920 30    # vertical short contract
```

```bash
# Manim — save last frame, or a range; then probe:
manim -s -ql scene.py MyScene                       # media/images/.../MyScene.png
scripts/probe-mp4.sh media/videos/scene/480p15/MyScene.mp4
```

```bash
# Generic MP4 (hyperframes, ffmpeg, external pack output):
scripts/probe-mp4.sh out.mp4 1920x1080 30    # asserts w×h and ~fps
scripts/probe-mp4.sh out.mp4                 # just prints the spec
```

`probe-mp4.sh` reads real `stream=width,height,codec_name,r_frame_rate` from
the encoded file (not from the render config) and prints:

```
  short.mp4: 1080x1920  h264  30 fps  15.00s
  ✓ spec OK
```

It fails with a non-zero exit and a `✗` line when resolution or fps drifts, so
CI or a script step can gate on it.

## Route by extension

Use this from the parent `SKILL.md`'s `--verify <file>` subcommand:

| Extension | Helper(s) |
|---|---|
| `.mp4`, `.mov`, `.webm` | `probe-mp4.sh` (asserts spec) |
| `.html`, `.htm` | `seek-shot.sh` then `contact-sheet.sh` on the frames |
| `.png`, `.jpg` (multiple frames) | `contact-sheet.sh` directly |

For any other extension, fall back to `ffprobe` directly and print the
container / codec info.

## Failure modes worth watching

- **Resolution / fps drift** — the render config said `1080×1920 @30` but the
  encoder wrote something else. `probe-mp4.sh` catches this.
- **Codec mismatch** — file is `hevc` or `vp9` when the platform needs `h264`.
  The probe prints a `⚠ codec` warning; still exits 0 unless res/fps also
  fail, so read the output.
- **Loop seam** — first and last frame differ in a loop. Add `-1` to
  `seek-shot.sh` times to grab the final frame and eyeball it against `t=0`
  in the contact sheet.
- **FOUC / late paint** — the Chromium screenshot fires 600 ms after seek
  by default. Some fonts or lazy assets need longer — inspect the sheet;
  re-run with the harness delaying its `ready` signal if needed.
- **Clipped text / off-canvas** — the contact sheet exposes these visually
  in one image; no other tool needed.
