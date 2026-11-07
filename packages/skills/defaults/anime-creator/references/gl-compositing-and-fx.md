# GL sets, light FX and compositing (the $0 tier)

The 2D-on-3DCG look (ufotable, Demon Slayer) is mostly compositing: painted layers with real parallax, light
that blooms over the drawing, weather that reacts to the action, impact frames and camera grammar. All of
it is code in `assets/film-engine/`, costs nothing per shot and stays editable until the last render.

## Engine contract

- `engine/src/boot-film-engine.js` `bootFilm({ scene, fxCues, editCues })` builds one WebGL renderer on a
  transparent canvas, the scene's sets, weather, cels and sparks, the edit timeline and the captions.
- A frame is a pure function of edit time: seeded random (`rng`), analytic particles, no state carried
  between frames. HyperFrames renders with parallel workers that seek out of order; anything stateful
  flickers.
- HyperFrames contract: composition id `main`, the paused GSAP timeline in `window.__timelines.main`, and
  `window.__hf.buildReady.engine` resolved once textures are loaded.
- `core/film-constants.js` imports the scene's `edl.json`: `SHOTS`, `FPS`, `DURATION`, `shotAt`, and easing
  helpers (`seg`, `bell`, `pulse`, `lerp2`, `easeInOut`, `bez`).
- Per scene, three files change: `src/scene/scene-config.js` (what GL draws), `src/scene/fx-cues.js` (light
  FX per shot in edit time), `src/scene/edit-cues.js` (DOM camera, shake, flashes, impact frames).

## Multiplane set (`gl/multiplane-set.js`)

- Each layer is a plane at its own depth in front of a perspective camera, covering its bbox as seen from
  the rest camera. Depth order and bboxes come from the layer-decomposition JSON, not from guesses.
- `pose({ x, y, z, roll, tilt, yaw, focus })` per frame; camera paths live in `SCENE.cameras` as functions
  of edit time. A dolly or crane gives true parallax; a slow push alone on a flat plate does not.
- Figure cards stand on the set: `addCard(texture, { depth, groundRow, x, height, shadow })` puts the feet
  on the ground row at that depth, so scale and parallax follow the camera. Screen-pinned feet were the
  cause of "floating on the roof".
- Rest blur per layer (mip bias) fakes depth of field; the fragment shader un-premultiplies after the fetch
  so blurred edges do not darken.
- Shader pitfalls met: undeclared uniforms and the GLSL reserved word `half` broke a build; textures load
  premultiplied with three.js colour management off.

## Weather (`gl/particle-weather.js`)

Presets `petal`, `sakura`, `snow`, `ember`, `leaf`, `ash`; instanced tumbling quads with backlit
translucency, lens-near softening and analytic wind, turbulence, vortex and burst. Per shot in
`SCENE.weather.perShot`: density, size, swirl, wind. `atDepth([x, y], d)` places an emitter at a screen point
and depth.

- Tune density by shot size. At full density petals read as white snow; ×0.55 and pinker read as petals.
- Make weather react: a vortex around a spin, a burst on a clash, wind direction following the flight.

## Light FX (`gl/light-fx-glow-and-sparks.js`)

`LightGlow` is one fullscreen pass: `streak(i, head, tail, col, k)` comet streaks, `glint(i, p, size, rot,
col, k)` 4-ray stars, `arc(...)` crescent qi arcs, `flash(p, k)`. `SparkBurst.fire(age, p, opts)` sprays
ballistic sparks. `fx-cues.js` has a `hit(t, a, p, fx, opts)` helper that combines flash, glint and sparks.

- Screen space: centre (0,0), y in [-1, 1] up, x in [-16/9, 16/9]. From a contact-sheet position (u, v in
  0..1, v down): `x = (u - 0.5) * 3.556`, `y = (0.5 - v) * 2`.
- Positions are measured on the conformed clip or cel with a grid contact sheet, then written into
  `fx-cues.js`. An eyeballed flash centre sat off the sword contact and the user noticed.
- On cel shots use the mapper returned by `CelPlate.show(tex, zoom, focus)` (`fx.map(point)`), so glints
  ride the push-in.
- On a video shot whose clip moves (pan, push, a subject that drifts), a glow at a fixed spot holds still
  while the picture slides under it and reads as a layer pasted on top. Track the clip and give the scene
  `tracks`, then write every clip position through `fx.map(p, at)`, where `at` is the edit time of the frame
  the point was read on (default: the shot's first frame):

```bash
uv run --with opencv-python-headless --with numpy python scripts/track-plate-motion.py <scene-dir> \
  s07 s14@0.3,0.25,0.8,0.8 --sheet /tmp/tracks   # optional region in frame fractions, y down
```

```js
import { TRACKS } from "./plate-tracks.js";      // scene-config.js: written by the script
export const SCENE = { ..., tracks: TRACKS };
glow.flash(map([0.2, -0.05], s + 2.55), 0.25 + pulse(t, s + 2.55, 0.4), BLUE);   // fx-cues.js
```

  The script fits one affine per clip frame (corners tracked with Lucas-Kanade, a forward-backward check and
  RANSAC). Give it a region around what the FX sit on when the subject moves against the background, and
  check the `--sheet` grids before trusting a track: a hard camera move or a cut inside the clip breaks it.
  Where it breaks, fade the FX out before that point instead of mapping it.
- One shot, two motions (a figure rising against a still street): the shot's own track feeds `fx.map`, and a
  `name:shot@box` spec stores a region track under `name` for the FX on the subject. Read it by hand with
  `trackMap(TRACKS[name], s, t)` from `engine/core/plate-track.js` (a DOM layer: `pinToTrack(sel, TRACKS[name], ...)`):

```bash
uv run --with opencv-python-headless --with numpy python scripts/track-plate-motion.py <scene-dir> \
  s15-chest:s15@0.30,0.12,0.66,0.62 --sheet /tmp/tracks
```
- Additive light over video needs a transparent premultiplied canvas and the ADD_LIGHT blend (rgb One/One,
  alpha Zero/One); petals use normal blending. The GL canvas lives inside `#cam` with the videos, so a
  camera move carries the FX with the footage.
- Restraint: a flash that fills the frame reads as the sun, blown streak heads read as a glitch. Peak
  additive intensity below white, flash 0.2-0.9 depending on the beat, bloom threshold at 1.0.

## Depth cels (`gl/cel-plate.js`)

A cel shot is a flat push (`SCENE.cels.<id> = { zoom: [z0, z1], focus: [u, v] }`) until its entry gets
`depth`; then the plate ray-marches the cel's depth map and near and far parts of the drawing move apart.
Maps come from `scripts/make-depth-maps.py <scene-dir>...` (Depth Anything V2 Small on the CPU, `<cel>.depth.png`
beside each cel, white = near). A shot without `depth` renders exactly as before.

Use `depth` only on a cel whose layers were painted apart. On a single painting the dolly slides near and far
planes against each other and reads as cut-out layers jittering over the footage (FRONTIER EP01 had every
depth cel flattened back to a push for this).

```js
s01: { zoom: [1.0, 1.1], focus: [0.5, 0.48],
       depth: { dolly: [0, 0.15], truck: [[0, -0.01], [0, 0.015]], focusDepth: 0.3 } },   // strong dolly down a hall
s06: { zoom: [1.0, 1.012], focus: [0.5, 0.5], depth: { orbit: 4, focusDepth: 0.25 } },     // a dialogue hold breathing
```

- `dolly [z0, z1]`: push toward the pivot plane; near planes grow by `1 / (1 - z * r)`, `r = depth - focusDepth`.
  0.1-0.2 reads strong; above 0.25 thin parts (claws, rails) smear.
- `truck [[x0, y0], [x1, y1]]`: camera travel in frame heights (+x right, +y up); near planes slide against it.
- `orbit deg | [a0, a1]`: arc around the pivot plane (a number sweeps -deg/2 to +deg/2); 2-6 for a hold.
- `focusDepth` (0.5): the pivot plane that holds still, 0 far .. 1 near. Put it on the subject; 0.25-0.35
  splits the motion between foreground and background, which hides edge stretch best.
- `strength` (1) scales all three; `ease`: `inOut` (default), `in`, `out`, `linear`; `map`: another depth file.
- The plate zooms in just enough (overscan, from both ends of the move) that no edge is revealed, so a depth
  shot frames slightly tighter than its flat version. Disoccluded gaps stretch the background next to the
  edge (the map's near side is grown a few px so silhouettes stay crisp); keep moves where that stays small.
- FX mapper: `fx.map([x, y, d])` takes the point's depth-map value as a third coordinate so a glint rides
  its own plane; without it the point moves with the pivot plane.

## Edit cues (`edit/dom-edit-helpers.js`, used in `edit-cues.js`)

`cam(shot, from, to, ease)` moves `#cam` (scale, x, y, rotation) over a shot; `shake(t0, dur, amp)` seeded
and decaying; `whipIn(t, px, dur)` directional blur into a cut; `flash(t, peak, dur)`; `tint(t, peak, dur,
colour)`; `impact(t, n)` n inverted frames; `hit(t, opts)` impact frames + flash + shake together.

Neither `shake()` nor a `cam()` move adds overscan, so a hard shake, or a `cam()` slam whose x/y travel outruns
its own scale, can show the frame edge for a few frames (the rig's cover zoom only covers the rig). Pass
`{ cover: true }` to `shake()` or `hit()` so each shake step scales just enough to hide its own travel and roll,
and keep a `cam()` move's |x| and |y| inside `(scale - 1) / 2` of the frame (a 1.1 push has 54 px to spare
vertically). A shot's `xfade` dissolves out of the previous cel with that cel's push still running, so the
outgoing plate never freezes under the incoming move.

### Shake and tint

- **Shake zoom.** The `cover` zoom follows the shake's amplitude envelope and eases in and out over 4
  frames. If the zoom follows each random step instead, it pumps, which the user saw as "the frame jerks
  slightly on every camera shake" ("khung hình hơi giật nhẹ mỗi lần rung camera"). `hit()` passes
  `snap: true`, so an impact starts at full strength.
- **Checking the edge.** Check covered shakes with `qa-prescan.py picture`, then a zoomed crop of the
  flagged edge. A whole-frame thumbnail hides a 6 px wedge.
- **`#tint` cannot darken.** It is a screen blend, so it only lifts toward its colour. For a dim, a
  blackout beat or a "power cut", use the template's `#dim` layer (`rgb(6, 4, 2)`, normal blend, between
  `#tint` and `#flash`): `tl.set("#dim", {opacity: 0.7}, t)` then `tl.set("#dim", {opacity: 0}, t + 2 * F)`
  for a two-frame flicker.
- **Measure each FX on the picture.** Do not trust its parameters. Zoom crops on the flash centre, the
  decal and the glint: a decal that drifted off a moving chest across three shots was caught by a crop, not
  by the full frame.

Camera rig (`edit/camera-rig.js`, on the same kit): pure functions of edit time summed into one transform on
`#fx`, which carries videos, GL and pinned props (captions and vignette stay put), with a cover zoom so no
frame edge shows. It stacks on `cam()` and `shake()`. On a depth cel the rig's travel also moves the near
planes more than the far ones (`parallax`, default 1), and `rackFocus` drives the plate's depth of field.

| Cue | Use |
|-----|-----|
| `handheld(t0, t1, { profile, amp, freq, seed, ramp, parallax })` | operator drift; `profile`: `calm` (dialogue), `walk`, `run`, `panic`, `quake` (rumble) |
| `sway(t0, t1, { amp, freq, seed, ramp, parallax })` | panic pendulum: roll about 2.2 deg with a figure-eight drift |
| `crashZoom(t, { to, dur, focus, until, back, blur })` | punch to `to` (1.35) about a screen point `[u, v]` (y up) in 4 frames, hold to the shot end |
| `snapZoom(t, to, opts)` | the same punch on the frame, no travel, no blur |
| `whipPan(t, { dir, dur, dist, blur, side })` | swing across the cut at `t`: out-going shot streaks off, next one lands, peak blur on the cut |
| `dutch(t0, t1, deg, { rollIn, rollOut })` | roll the frame (+ clockwise), on the cut or eased |
| `rackFocus(t0, t1, from, to, { at, dur, aperture })` | depth cels only: focus plane from depth `from` to `to`, blur px per unit of depth |

```js
k.handheld(at("s06"), at("s07"), { profile: "calm", seed: 4, ramp: 0 });   // the freeze, held by hand
k.sway(at("s16"), at("s17"));                                                 // the room panics
k.handheld(at("s08"), at("s10"), { profile: "quake" });                      // the dome bursts
k.crashZoom(at("s17", 0.1), { to: 1.3, focus: [0.5, 0.55] });
k.whipPan(at("s04"), { dir: "right" });                                       // replaces whipIn on that cut
k.dutch(at("s18"), at("s19"), 8, { rollIn: 0.6 });
k.rackFocus(at("s15"), at("s16"), 0.9, 0.1, { at: at("s15", 1.5), dur: 0.8, aperture: 12 });
```

DOM layers that sit on the picture (rain, a HUD, a screen insert, a scrawl, a label on a prop) go inside
`#cam`, or the camera rig moves the footage while they hold still. Two more cues keep them on their plate:

| Cue | Use |
|-----|-----|
| `followCel(sel, shot, SCENE.cels.<id>)` | scale a full-frame wrapper with a cel's GL push (same zoom and focus), so a screen or reflection laid on the cel stays on it |
| `pinToTrack(sel, TRACKS.<id>, at(shot), { at })` | from `engine/core/plate-track.js`: a full-frame wrapper follows a tracked clip frame by frame; `at` is when its layout matches the plate |

Wrap the overlay in a full-frame div (`position: absolute; pointer-events: none`) and pin or scale the wrapper,
so the cue's transform does not fight the overlay's own tweens. Screen furniture such as captions, name cards
and a viewfinder frame stays outside the camera on purpose.

**No layer-split parallax.** The user's note, verbatim: "một số cảnh đang bị giựt giựt do tách layer mà video
nền di chuyển trong khi layer trên đứng yên". Some shots jerked because a layer had been split off: the video
behind it moved while the layer on top stood still. The note recurred in the OST MV and across all five scenes.

- Moves on a single painting are flat cel pushes, with no depth dolly.
- Any overlay or glow on moving footage rides the plate: put it inside `#cam`, then use `followCel`, or
  `pinToTrack` with a region track from `track-plate-motion.py`.
- Before sending a cut, check every overlay with a strip across the move.
- An older note asked for "layer depth" on a dolly (cut 1, 01:25); this later rule wins. A still that must
  move gets Omni or H3 motion, or a flat push plus handheld; a depth dolly on a cel only where the user
  accepts it.
- When a drawn screen is in perspective, corner-pin its content with `matrix3d` on a wrapper. A flat DOM
  rectangle on an angled monitor was a user note.

Grammar: calm handheld on quiet beats, panic or sway only while the characters panic, quake under an
explosion with a `shake()` hit on the frame; one crash zoom per beat, and a whip pan instead of a plain cut
only where the eye should be dragged to the next shot.

## Anime craft that reads as "real production"

- Timing: characters on 2s or 3s for stylised action, camera and compositing on 1s. Hit-stop: hold 2-4
  frames at contact, then release faster than it came.
- Impact frames: 1-2 frames of inverted or silhouette image at the hit; a hit without them reads soft.
- Smear and speed: speed lines or a directional blur for the frame before a strike; afterimage ghosts
  on a dash. Too much smear averages a character away (a launch frame lost the oni entirely).
- Depth: three planes minimum (foreground element, action plane, background) and a camera move that
  separates them. Foreground petals passing the lens sell depth for free.
- Micro-acting layered over stills: eye glint that pulses, a blink, breathing scale of 0.5%, a hair lock
  moving (or an Omni insert for real hair motion).
- Grounding: contact shadow under feet, dust or petals kicked at a landing, a camera dip on impact.
- Sakuga beats get the most layers (flash + sparks + shake + impact frame + SFX hit on the same frame).
  Quiet beats get almost none; contrast is what makes the hits land.

Measured on eight action references (shot sheets plus `measure-reference-cut.py`, 2026-10):

- Impact frames ran 3.1-21.8 a minute (median about 6.5), each 1-4 frames: a white silhouette on black,
  an inverted or monochrome red frame, or white and black frames alternating for 0.1-0.3 s. FRONTIER ep02
  had 2.3 a minute. On a climax, plan one per strike, not one per scene.
- FX on ones over characters on twos: rings, lightning and fire changed every frame while the figures held
  for two, which reads as speed without redrawing the character.
- Transitions made of FX: one reference ran a 30 s long take with 16 shots and changed angle through
  full-frame bursts, slashes and streak fills instead of cuts. A smash to black on the last hit ends a
  sequence harder than a fade.
- Inserts before a release: an extreme close-up of the eyes, or a crash zoom onto a shouting mouth, held
  0.3-0.6 s; the palette goes monochrome (warm, or inverted red) for the technique and returns after it.
- Holds are rare in action: 0-0.36 of runtime was held (no block moving 5 luma in 0.5 s), ep02 0.65 with
  a longest hold of 7.4 s. A still cel in an action beat needs a camera move, an FX layer or moving sound
  on it; the hold before the climax and the end hold (3.8 s in the long take) are the deliberate ones.

## Engine reuse across episodes

The engine is copied into `<series>/engine/` once and shared by every scene. Improve it there (new FX
preset, new set behaviour) and keep scene files declarative. `anime-studio.py build <scene>` bundles with
esbuild; a scene with only config changes rebuilds in seconds. A generally useful engine change belongs
back in `assets/film-engine/` with a note in the run report.
