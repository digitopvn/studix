# Keyframes, plates and AI video inserts

Generated pixels are bought, so each one is planned in gen-plan.json, compiled from the bible, checked by
measurement and logged. Jobs run through `scripts/generate-media-via-multix.py <episode-dir>`.

## Keyframes and sheets

Job fields that drive the prompt: `characters`, `set`, `framing`, `action`, `staging`, `emotion`, `camera`,
`seed`. `anime-studio.py prompt <ep> <job>` shows the compiled prompt before you pay for it.

- Model sheet first (job kind `sheet`, text-to-image when no reference exists yet), approved at G1, then a
  reference for every later image of that character.
- Framing margin: "the whole figure and the whole weapon inside the frame with at least 8% empty margin on
  every side; nothing touches an edge". Generators draw to the canvas edge; a hard-cut arm or blade inherits
  that edge and the user sees it before any QA does.
- State facing ("faces screen-left"), weapon hand, and for contact shots the contact point ("blades cross at
  mid-blade, his edge pushing down on hers"). Solve contact geometry first (point, angle, who is where,
  180-degree rule), then write both shot and reverse shot from it.
- Staging from the set file: real perspective (low angle, three-quarter, ground receding into depth), feet
  on the ground row with a contact shadow. Flat side-on stages read as an old 2D game; figures without
  ground contact read as floating.
- For a first/last-frame pair, frame B follows the shot's `boundary` mode (see "Shot joins by camera intent"):
  `locked-composition` keeps A's framing; `camera-transition` ends on a new composition named in
  `camera.to`; `intentional-cut` is a fresh frame. "Same framing as A" on a camera move makes the insert jump.
- Outputs can come back as jpg even when png was asked; match files with `*.(png|jpg|jpeg|webp)(N)` in zsh.
- `multix atlas image-to-image` takes `--no-webp`; put `--` before a prompt that could start with a dash.

Keyframe QA before any video is bought: the `## keyframe` prompt of `assets/templates/qa-prompts.md`
(staging, crops, logic, design, verdict) plus a look at a 1000px preview, plus `anime-studio.py edge` for
cut-outs. Retake with a tighter action text and fewer references; about one in five to eight keyframes
needed one.

## Plates and the multiplane set

- Establishing frame of the set (Nano Banana), then `layer-decomposition` into a base and layers with
  z_index and bbox; those drive `multiplane-set.js` depths. Cheaper alternative when the set is simple:
  hand-cut layers from one painting.
- Side-on plate that should recede: `scripts/warp-plate-yaw-perspective.py in.png out.png` (a pure camera
  yaw re-projects exactly). If the result still looks wrong, regenerate the plate from a perspective prompt;
  regenerating a roof was faster than fixing it.
- Depth for a 3D set: `scripts/estimate-plate-depth.py model.onnx plate.png depth.png` (Depth Anything V2,
  local ONNX; hosted depth models were blocked by the network once).
- Character cards over a set: draw on flat #00FF00, then `scripts/chroma-key-cutout.py in.png --out-dir DIR`
  (premultiplied RGBA, despill, feather, rim; its JSON lists `edge_touch`). A figure that should be whole and
  touches an edge goes back for a retake or a scripted extension.

## Omni inserts (T2)

Atlas `google/gemini-omni-1.1-flash/image-to-video`: `image`, `last_image`, `duration` 3-10, `resolution`
360p/720p/1080p/4k, `seed`. 24fps, native audio with lip-synced speech.

- Brief the acting, not only the action: eyes, breath, a micro-expression change, hair locks moving. This
  is where the user's "wow" came from (pupils, mouth, hair).
- Put the line in the prompt in the spoken language when the character talks. Omni misread a kanji
  (天 as "ten"); check its speech with seed-asr and replace with TTS if it is wrong.
- An end pose the model never sees is ignored (the sword was never sheathed). Give it as `last_image`.
- Omni sometimes cuts to a new angle by itself mid-clip. Inspect the contact sheet; a clean internal cut is
  two shots for the price of one.
- The whole-cut edit mode (feeding an edited film to restyle) rewrote shots and broke timing. Use Omni for
  single-shot inserts from key drawings only.
- Ordered work: 360p seeded previz when choosing between several candidates, then 720p for the keepers.
  This holds for Omni only: a low-resolution probe of local H3 did not predict its 768p take of the same
  seed, so H3 renders at the target size (below).
- **Guards on every Omni prompt.** End it with a fixed negative suffix: "one continuous shot, no cuts or
  angle changes, no subtitles, captions or on-screen text". Add a cast clause naming each character who
  "appears exactly once, never duplicated". Leave the location `set` text empty (`set=""`) and let the
  reference image carry the set: set text once morphed a room into a green corridor and printed signage.
- **Probe before a batch.** One clip per new shot type (Omni or H3) before buying the rest.

### Traps measured on FRONTIER EP01

- **Edit mode.** Omni edit (video-to-video) rejects `--aspect-ratio` with HTTP 400. Leave the flag out; the
  output keeps the input's aspect.
- **MiniMax H3** (`minimax/h3/image-to-video`) for physical action: falls, stomps, runs, spit-takes. Requests
  under 4 s fail with only "next: multix atlas run --help"; ask for 4 s or more and trim. Give the landing
  pose as `end_image`. The clip snaps toward the end frame when its angle differs (a jump at about 3 s of a
  4.5 s probe), so plan a cut there. A provider "system error" cleared on resubmission under a new id.
- **Safety refusals** are not billed. Rephrase the action neutrally, never the character, and resubmit
  under a new job id. After two refusals on one shot, switch it to a cel with code motion or to H3; do not
  keep retrying (a mother-and-child frame kept refusing).
- **Burned-in text and duplicated characters** still slip through the guards, usually after a hidden cut.
  QA checks every clip's contact sheet for both.
- **Free repairs before a paid retake**, cheapest first:
  1. choose `in`/`out` points that skip the internal cuts (`qa-prescan.py clips`);
  2. freeze on the frame before glyphs appear, or hold a clean stretch (`tpad` clone);
  3. remove a burned caption, or blur a sign with a narrow box plus a hue filter (`--hue any` smeared the
     building windows);
  4. patch the residue from an aligned clean neighbour frame;
  5. `multix gemini edit-video` on the clip, without `--aspect-ratio`.
  An Omni retake costs at least $0.30 and another QA round. Accept a minor geography slip the user signs off
  rather than paying for it.
- **Real brands** on billboards or screens: blur them in post with a masked blur over the tracked region
  (the episode's `blur_signs.py`). Use a hand-placed mask; do not build an object detector for one shot.
- **Clips animated on twos.** `mpdecimate` cannot find the held frames, because grain and the grade make
  every frame differ. Mark the shot `"twos": true` in the EDL instead: `conform` keeps the even drawings and
  retimes them, so a slowed source does not judder.

## Seedance (T3)

`bytedance/seedance-2.5/image-to-video`, first/last frame, at most 4s. Limbs morph after 4-5s; cover the
risky stretch with a cut, a speed ramp (x1.25 tightened one shot) or a cel at the peak. The default is one per
scene; when an episode is action-heavy, a probe beats H3 on the same beat and the user approves, route every
big-action shot to it (FRONTIER ep03 sent 16 action shots to Seedance at 480p after the user judged them
"much better" than H3) and run with `--allow-seedance`.

- **Route by price.** The same model through another reseller cost about a third: $0.42 per 4 s at 480p
  (about $0.105/s, native audio included) against $0.30/s at 720p on Atlas. Price every route with a probe
  before the batch; the 480p take is upscaled with the finished scene.
- **Physics with a visible cause.** Write grounded motion (tyres on the road, weight on landings) and show
  what causes each event in frame (the car swerves because a drone dives at it). Rejected takes drifted or
  floated, drove into a bin for no reason, flew over a truck it should hit.
- **Camera side and trajectory live in the frames.** Draw the first and last frames from the side the
  sequence is cut from (behind the car in a chase) with the start and end positions of the path; a prompt
  alone did not hold them. Do not draw the moment of impact as a keyframe: the model freezes on it.
- **No pre-placed extras.** Enemies or drones standing ready in the first frame read as staged; let them
  enter during the shot.
- **Native SFX.** Its own audio track can beat video-to-audio Foley for action (`audio-voice-and-mix.md`).

## 3D blockout as motion and camera reference

A grey Three.js blockout (figures as capsules, sets as boxes, the camera keyed per beat) pins camera moves,
cuts and timing for a hard action shot that a prompt alone cannot hold. Render it at the clip's size and fps,
plus a depth pass, and feed it one of two ways. Measured on one 5 s climax shot (four cut angles):

- **Local H3 with depth control** (ComfyUI, MiniMax H3 + Fun ControlNet depth, keyframe as frame 0, sheet as
  ref image). Strength decides it: at 1.0 H3 copies the depth map literally, grey shapes and all, with or
  without the ref image. A simple orbit worked at 0.7 (0.85 still copied); the four-angle climax only at 0.5.
  Start at 0.7 for one angle, 0.5 for multi-cut shots, and check the contact sheet for grey geometry before
  judging anything else. About 150 s and 15.5 GB VRAM per 5 s clip; free, but the impact landed off the
  blockout's frame.
- **Cloud reference-to-video** with the blockout as the reference video, the keyframe and the sheet as
  reference images. All three models tried kept the four-angle cut structure, which depth on H3 did not:
  - `bytedance/seedance-2.0-mini/reference-to-video`: $0.58 billed for 5 s 720p; closest to the blockout and
    on-model. Prompt refs as "image 1", "video 1". It has no first-frame field: `image` next to reference
    media is rejected with HTTP 400 (multix labels it CONTENT_BLOCKED), so the runner appends the keyframe
    as the last reference image (one past the reel; do not list it in the reel too) and refuses a `last`
    frame. It still holds the keyframe's blocking, but redraws frame 0 (about 10/255 mean
    difference); `qa-shot-boundaries` judges a chained join against the chain still and `--chained-ratio`
    (below), so this redraw alone no longer flags it.
    Measured 4 s at 720p: $0.4088 ref2v, $0.3911 i2v.
  - `kwaivgi/kling-v4.0/reference-to-video`: $0.87 (input video seconds billed too); the most polished frames
    and the impact on the blockout's exact frame, but it drifted from the blockout mid-shot. The `image`
    keyframe is `@image_1` and reference images number after it (`image_tag_offset: 1` in engines.json);
    videos are `@video_N`. No audio switch, no seed, 1080p by default. Measured 4 s: $0.6843.
  - `bytedance/seedance-2.5/reference-to-video`: $1.80, no better than mini here (smeared face on the dive);
    refs as `@Image1`, `@Video1`; `seed` is outside its published schema.
- In every route, blockout props come through literally: cube debris stayed cubes. Model debris, sparks and
  smoke as irregular shapes in the blockout, or leave them out and describe them in the prompt.
- Open the prompt with one line that gives each reference its role ("the exact first frame", "the character
  sheet", "a grey 3D blockout: follow its camera, cuts and timing, render as finished anime, never grey 3D
  shapes"), then the timed beats.

## Shot joins by camera intent

An EDL shot may carry `boundary` for its join with the previous shot (`studio/shot_boundary_contract.py`):

| Mode | Needs | Chains last frame |
|---|---|---|
| `locked-composition` | same set | yes |
| `camera-transition` | `camera: {from, to, move}` | yes, as the start only |
| `intentional-cut` | `cut`: hard, match, on-action, whip, fx | never |

- `validate` errors on a locked join across sets, a transition without from/to, a chained cut, and an actor
  whose `axis` side or `hands` prop hand flips across a continuous join (unless
  `boundary.intentional_discontinuity` gives a reason). Shots without `boundary` behave as before.
- The prompt compiler adds the join sentence for the mode; `context-pack` prints the shot's continuity state.
- `anime-studio.py chain <ep> <job-id>` proposes the previous accepted take's last frame as the next first
  frame, with frame index and sha256; it refuses a rejected source or a major defect in the last 6 frames. A
  retake of the source makes the chain stale. `--at <seconds>` or `--at edl` takes the frame at that point
  instead (`edl`: the out-point of the EDL shot whose `src` is the clip, `in + (end - start) * speed`; a
  salvaged take filling several shots uses the job's own shot, else it lists them and asks for seconds; when
  only a trimmed or upscaled copy reads the clip (the clip in `src_raw`), or the job's own shot is such a copy,
  it is refused because the copy's `in` does not count from the clip, or `src_raw` may be stale), checks the 6 frames before it, and prints the ffmpeg command for
  `gen/keyframes/chain-<job>-at<ms>ms.png`. The still is cut by time (the last frame starting before the point,
  a frame exactly on it excluded, counted from the clip's first frame), so it is right at any source frame rate,
  23.976 and 29.97 fps included, and for a clip whose timestamps start above 0; past the clip's end it keeps the
  last frame. The command decodes from the start (`-i <clip> -vf trim=end=<at>`, about 0.8 s for 15 s of
  1080p): a seek wrote no still for an offset clip or a point past the end. Use it when a
  take is only usable up to mid-clip (a prop vanishing later): the bench drone take chained at 1.25 s.
- `anime-studio.py previz-camera blockout.json T0 T1` turns blockout camera keys into from/to/move words
  (a proposal to review, not a final camera).
- `qa-shot-boundaries.py <scene-dir> [--strips DIR]` compares the frames either side of each join on a
  160x90 proxy (luma, histogram, change ratio vs the shot's own motion); continuous modes flag a jump,
  intentional cuts are allowed, shots without a contract are info. Exit 1 when anything is flagged. A join
  into a chained i2v shot (`boundary.chain`, or a job with `chain`) is judged with `--chained-ratio`
  (default 4.5; the redrawn start measured 3.48, real cuts 5.54 and up), and `src_ratio` compares A's last
  frame with the still B was chained from: above `--ratio`, the still was not taken where A was cut. A join
  is seen as chained when the EDL `src` (or, when no video job has that `out`, `src_raw`) is the job's `out`, so it survives `trim --rewrite` and an
  upscale; after a salvage remap set `boundary.chain` on the shot, or it is judged as an unchained join.

## Reference reels and take salvage

- `anime-studio.py ref-reel <ep> reel.json [--role i2v-cloud] [--engine NAME]` builds a reviewed manifest of a shot's
  references (role, sha256, video spans) and the payload the adapter gets from its `refs` caps in
  engines.json. An adapter without video input gets first and last stills of each motion reference. The
  ffmpeg commands are listed, not run. The Seedance 2.0 mini and Kling v4 ref2v keys were verified by a paid
  probe (2026-10-26); other ref2v adapters stay unverified until one.
- Two `generate-media-via-multix.py` processes may run on one episode (a background `--fetch` and a new
  submit): each save takes `gen-plan.json.lock`, re-reads the plan and writes back only the fields it
  changed (set by the call or in place, such as a held request id), so neither drops the other's jobs. Each
  run still selects jobs from the plan it loaded, so two submit or `--retry` runs on overlapping jobs would
  both pay: split them with `--jobs`. A save that cannot write the plan stops the run before any queued job
  submits; every job whose save failed (jobs already in flight on other threads included) is printed with its
  pred_id and its update appended to `logs/unsaved-jobs.jsonl`, which the next run (not `--dry-run`) merges before
  selecting anything; a merge that fails (or a run killed mid-merge) leaves the rows for the run after. A save or merge writes a job only if its `status` and `pred_id` on disk are still what the run
  started from, so a late result of an old prediction never overwrites a resubmission another run made.
- `anime-studio.py salvage-plan <scene-dir>` reads `salvage.json` (takes with defects, wanted shots) and
  writes `work/salvage/` proposals: clean spans cut frame-aligned around major defects, assignments to the
  wanted shots, utilization and cost per accepted second, and a mix remap for shots that list `replaces`.
  Minor defects mark a span `needs-fix`. Nothing touches the EDL or the mix until merged.
  `retakes_avoided` counts the shots a whole-clip keep-or-drop could not have filled (every span of a take
  with a major defect), listed in `salvaged_shots`; `retake_usd_saved` prices each
  at `--retake-usd`, else the cost of the take used.

## Local image-to-video (role `i2v-local`)

`generate-video-via-comfyui.py` runs one clip on a local ComfyUI server from any workflow the `i2v-local`
role names (default MiniMax H3; LTX-2.5 is shipped as a second adapter). It uploads the keyframe, fills the
workflow's slots, waits, downloads, and writes a sidecar with the parameters, wall time, peak VRAM, frame
count and `cost_usd: 0`. Free per clip, so it suits physical action inserts and retakes when cash is tight;
it is slower and one job at a time.

- Start the server yourself (`<ComfyUI>/main.py --listen 127.0.0.1 --port 8188`); the script never assumes
  where ComfyUI is installed. `--dry-run` prints the filled graph without a server.
- H3 needs 4 s or more and snaps toward its end frame, like the cloud H3; `--guide-audio` anchors an approved
  TTS take on the lips (MiniMaxH3AddGuide). Trim the take's leading silence first (AddGuide picks carried
  0.10-0.17 s) and measure lip-sync on the render, not after the edit.
- **Measured on one 16 GB GPU** (FRONTIER ep03, 112 shots, 192 takes, 17.3 GPU-hours): a median 301 s per 4 s
  take at 1344x768, 1008 s for 10 s; 88% of shots were accepted locally and the rest went to cloud H3 at 768p
  ($0.32 a clip, 16 of 16 accepted on the first take). Plan GPU time from these numbers, not from cash.
- **It fails by prompt pattern, not by seed.** The same defect repeated across seeds: a hidden cut near
  frames 24-26, a crash zoom, figures turning to the camera, mouths opening in silent shots, invented name
  tapes on uniforms, a swapped background, props from the bible text appearing in hand. When seeds 1 and 2
  fail the same way, change the prompt or escalate the shot to the cloud; do not spend a third seed on it.
  At most three seeds a shot, at the target resolution.
- **Clauses that held:** "lips pressed together, no speaking" on silent shots; no prop named unless the shot
  uses it (`series-bible-and-continuity.md`, "Staging record"); plain insignia instead of name tapes; "the
  camera holds its framing" against crash zooms.
- **Judge only the used range.** Score a take on the EDL `in`/`out` it will fill; a defect outside that range
  is not a retake.
- **Pipeline per shot.** Start a shot as soon as its keyframe passes QA; waiting for a whole scene's
  keyframes left the GPU idle. Have the queue write a `.done` file per shot (see
  `orchestration-and-environment.md`, "Watching workers").
- A new local model is a workflow file plus an engines.json adapter (`shot-tiering-and-model-routing.md`,
  "Roles, not engines"), and the comparison protocol there decides whether it replaces the current one.

## Async jobs and recovery

Atlas video and upscale jobs return a prediction id at submit. The runner appends ids to
`logs/predictions.log`, marks jobs `submitted`, and `--fetch` downloads them later
(`multix atlas status <id> --download --wait-timeout 600000`; the timeout is in milliseconds). A crashed
session loses nothing that was submitted. `--retry` runs `planned` and `failed` jobs. A prediction the
provider refused (`"status":"failed"`, `prediction <id> failed`, or HTTP 400/422 on that prediction's URL; a
timeout or a failed download stays `submitted`) becomes a `failed` job with
the provider's message in `error` and `error_code` `content_blocked` (a safety refusal) or `rejected` (a bad
request, such as Seedance's HTTP 400 for `image` next to reference media), so `--retry` picks it up; a
prediction still running stays `submitted`.

## Clip QA, trim, upscale, conform

1. `anime-studio.py sheet <clip> <out.jpg>` (0.25s tiles) and `strip <clip> <out.jpg> t0 t1` for an action
   beat; read the contact sheet at a size that shows hands and blades.
2. `## clip` QA prompt (defects, acting, audio, best range) as a hint list; confirm each defect on a strip.
3. Choose `in` and the shot length in the EDL from the best range.
4. `anime-studio.py trim <scene> --rewrite upscaled` cuts the used range plus a 4-frame handle into
   `trimmed/<scene>-<shot>.mp4` (so the upscale bills for used frames only) and, in the same call, points
   the EDL at `upscaled/<scene>-<shot>.mp4` with `in` moved to the handle (old path kept in `src_raw`).
   Then run the `upscale` jobs (input `trimmed/`, standard tier). Without an upscale, drop `--rewrite`.
5. `anime-studio.py conform <scene>` writes `clips/<shot>.mp4` with exactly round(len x fps) frames (speed
   applied, short sources held and reported) and `<shot>.wav` for shots with `audio: true`.

Frame counts after upscale matched the trims exactly in the measured run; check them anyway when the
upscaler or its settings change.

### Upscaling finished scenes instead of clips

When the finishing passes (FX, captions, grade) only run at 720p, upscale the finished scene renders, not the
raw clips: `upscale-finished-scenes.py <ep> --tag "{sc}-<cut>"` reads `renders/<tag>-master-720p.mp4` and
writes the `renders/<tag>-master.mp4` that `assemble-episode.py` joins. FRONTIER ep02 took 8 scenes to
1080p this way for about $2.6 on the standard BytePlus tier.

- An approved tag already has the Lanczos `<tag>-master.mp4` from `finish-scenes.py`, which the script never
  overwrites ("exists, kept"; three upscales hand-copied parts to a new tag). Pass `--out-tag "{sc}-<cut>-hd"`
  and `--part sc=tag` for scenes approved in another round; the 720p source lands beside the upscale, so
  `assemble-episode.py --tag "{sc}-<cut>-hd"` runs next, and `ledger` prices the ids from `logs/predictions.log`.

- Run `--test <scene>:<start>:<seconds>` first on a few seconds that hold captions with diacritics and fine
  FX, and look at it before paying for the cut. The 6 s test kept the Vietnamese captions intact.
- The script stops on any output that is not exactly the target size or does not match its source frame
  for frame (144/144 in the test); the sync of the joined episode depends on it.
- It sends a near-lossless picture-only copy, submits every scene before waiting, and keeps prediction ids
  in `upscaled/<tag>/ids.json`, so a rerun resumes without paying twice. Any upscaler fits the `upscaler`
  role: a local CLI adapter gets `{in} {out} {width} {height}`.

## Codex route (no cash, plan quota)

`codex exec --skip-git-repo-check -s workspace-write --add-dir ~/.codex/generated_images -i ref.png -- "<prompt>"`,
then copy the PNG out of `~/.codex/generated_images/<session>/`. Use the absolute path of the codex binary
the user's PATH resolves to (an older binary rejected the model), retry on "at capacity" with backoff, and
run at most three in parallel. The `multix openai --driver codex` route timed out without output.
