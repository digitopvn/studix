---
name: anime-creator
description: "Produce anime and cartoon films (single clips to multi-episode series) as a hybrid 2D-on-3DCG pipeline: interview and scope lock, series bible with consistent characters, tiered shots (code GL sets and FX, generated cels, short cloud or local image-to-video acting and action inserts, at most one sakuga shot per scene), HyperFrames edit with live captions, TTS voices gated and lip-synced onto the inserts, generated and recorded sound, AI-assisted QA, upscaled masters, measured cost ledger and a process report with every film. Engines fill roles through a routing table, so other models and local GPUs plug in by config."
when_to_use: "Use when the user wants an anime, hoạt hình, cartoon or ufotable/Demon Slayer-style animated clip, fight scene, episode or series, wants to continue or fix one made with this skill, or asks what such a film would cost. Not for live-action or photoreal AI films (ak-filmmaking), motion graphics, explainers or promos (motion-video, ak-motion-video), raw HyperFrames compositions (ak-hyperframes) or standalone voice and music work (ak-elevenlabs)."
user-invocable: true
argument-hint: "[new|episode|resume|fix|report|insights] [brief or series/epNN] [--auto] [--budget USD] [--fps 48]"
category: media
keywords: [anime, animation, cartoon, hoat-hinh, ufotable, series-bible, character-consistency, hyperframes, engine-routing, comfyui, image-to-video, tts, upscale, ai-qa, cost-ledger]
compatibility: "macOS, Linux or Windows (Git Bash) with python3, ffmpeg, node/npx, uv and multix (keys in ~/.multix/.env); network access for generation."
metadata:
  author: zuey-workspace
  version: "1.6.1"
---

# Anime creator

Make anime that holds up next to a Netflix or ufotable release at a few dollars per 15 seconds, and leave
behind a project that the next episode, the next agent or a later fix can pick up from files. The
pipeline is hybrid: painted sets and light are code (free, editable), held poses are generated stills, and
paid AI video is used only where a face or body has to act.

<args>$ARGUMENTS</args>

## Requests

| Request | What happens |
|---|---|
| `new [brief]` (default) | interview, G0 scope lock, G1 designs, then production through G4 |
| `episode <series> [brief]` | next episode of an existing series: read bible, story-so-far and continuity first |
| `resume <series/epNN>` | `anime-studio.py status` and continue from the last gate and trace event |
| `fix <series/epNN> [notes]` | turn feedback into tagged defects, fix cheapest-first, re-render, update the report |
| `report <series/epNN>` / `insights` | process report of a run / trends across all runs |

Flags: `--auto` runs G2-G4 without stopping (G0 and G1 still need the user); `--budget USD` sets the episode
ceiling (the init default is $4, sized for 15s; scale it with length); `--fps 48` only when the user asks
for it (24 is the master rate).

## Outcome

For each run, in `$ANIME_STUDIO_ROOT/<series>/episodes/epNN/`:

- `renders/<name>-master.mp4` (1080p, graded, mixed) and `<name>-preview.mp4` (25MB or less, for chat);
  for an episode, `finish-scenes.py` and `assemble-episode.py` add a 720p review master, a share copy and a
  phone copy under 30 MiB, each measured into `renders/deliveries.jsonl`;
- sidecar subtitles (`subtitles --format srt|vtt`);
- `reports/process-report-<run>.md`: what was done, decisions taken alone, workarounds, errors, retakes, QA
  findings and how they were verified, cash ledger, Claude tokens per phase, cost per film second, lessons;
- updated `story/story-so-far.md`, `story/continuity.json` and a row in `runs.jsonl`.

Send the preview and the report together; give the master's path. On an episode, send each deliverable as
soon as it exists, review at 720p, and upscale or finish at 1080p only after the user approves.

## Authority and limits

- The user approves G0 (scope lock) and G1 (character and set designs) in every mode. No keyframe, video or
  music job runs before G1 is approved. Design jobs (sheets, set frame) run only after G0.
- Spending stays inside the ceiling recorded at G0. Crossing it, or a single unplanned purchase above 20% of
  it, is a question for the user.
- Under `--auto`, also stop for: a change to locked scope, two failed paid retakes of one shot, a provider or
  model the plan did not name, anything touching IP, real people or the user's accounts.
- Credentials: keys stay in `~/.multix/.env`; load them quietly and never print, echo or log values or
  fragments. The scripts read keys from the environment and redact their logs.
- Paid outputs are never overwritten or deleted; a retake gets a new id.
- Characters, designs and music are original. Reference films are studied for timing only.
- Stop processes you started (renders, preview servers); leave other sessions' processes alone.

## Production order

Order matters where money is spent: nothing paid starts before the gate that justifies it.

| Phase | Do | Gate | Read |
|---|---|---|---|
| 0 Setup | `preflight`; pick `ANIME_STUDIO_ROOT` on the volume with the most free space; `init-series` or `init-clip` | | `orchestration-and-environment.md` |
| 1 Interview | up to three grouped rounds with options and a recommendation; manage expectations | | `interview-and-scope-gates.md` |
| 2 Scope | beat sheet with a tier per shot, dialogue table, budget via `budget`; `scope-lock.md` | G0 | `shot-tiering-and-model-routing.md` |
| 3 Designs | bible files, model sheets, set frame, layer decomposition, voices | G1 | `series-bible-and-continuity.md` |
| 4 Keyframes | staging record per scene, storyboard round, then gen-plan jobs, `prompt` to preview, runner batch, keyframe QA, retakes | | `series-bible-and-continuity.md`, `interview-and-scope-gates.md`, `keyframes-and-ai-video.md` |
| 5 Animatic | keyframes and cels cut to timing in the EDL, temp captions, draft render; optional 360p previz | G2 | `edit-captions-and-render.md` |
| 6 Video | price probe, submit T2/T3 at once; meanwhile GL sets, weather, FX cues, SFX and music | | `keyframes-and-ai-video.md`, `gl-compositing-and-fx.md`, `audio-voice-and-mix.md` |
| 7 Conform | fetch, clip QA, `trim --rewrite upscaled`, upscale, `conform` | | `keyframes-and-ai-video.md` |
| 8 Rough cut | `build`, draft render, temp mix, checklist | G3 | `edit-captions-and-render.md`, `grade-master-and-qa.md` |
| 9 Final | fixes, delivery render, mix, `grade --test`, grade, QA, report, `finish` | G4 | `grade-master-and-qa.md`, `report-and-telemetry.md` |

Trace as you go: `run-start` at the beginning, `phase` at each phase, `trace` for every decision,
workaround, error, retake and QA finding, `gate` for every gate outcome. The report is built from this.

## Failure modes this skill exists to prevent

Each of these cost a retake, money or the user's trust in an earlier run.

- **Cut-off limbs and props.** Generators draw to the frame edge. Ask for an 8% margin, run `edge` on every
  cut-out, and read action beats as full-size strips, not 480px tiles.
- **Grip and contact logic.** Write handedness in the character file and the contact point in the brief;
  solve the geometry before prompting the shot and its reverse.
- **Floating figures and flat staging.** Feet on the ground row of the set at their depth, contact shadow,
  perspective camera with height and angle, camera moves that show depth. Side-on sets read as an old 2D
  game.
- **Off-model drift.** Sheet first, at most three references, bible-compiled prompts (`prompt`). Retake
  with a tighter brief and fewer refs.
- **AI video defects.** Omni ignores end poses it never sees (give `last_image`), hides cuts (never span one
  with a shot: `qa-prescan.py clips`), duplicates characters and burns in text (negative suffix, cast clause,
  `set=""` on every prompt; free repairs before a paid retake), misreads hanzi/kanji (check speech with ASR).
  H3 needs 4 s or more and snaps to its end frame. Seedance morphs limbs after 4-5s: 4s or less, one shot
  per scene unless the user routes an action-heavy episode to it.
- **Staging that flips between boards.** Seats, sides, vehicle model, direction of travel, scale and props
  changed between panels and drew most of 39 storyboard notes on one episode. Write the scene's staging record
  before the first board and check every panel against it (`series-bible-and-continuity.md`).
- **Props leaking from the bible.** A habit prop in a character's text appeared in nearly every shot. Scope
  props per shot; every other shot says "empty hands".
- **Retrying a local model by seed.** Local H3 failed by prompt pattern (hidden cut near frame 24, crash zoom,
  turning to camera, talking in silent shots). Same failure on seeds 1 and 2: change the prompt or send the
  shot to the cloud.
- **Idle pipeline between sessions.** Worker sessions finished and nothing started for 2.5 and 12 hours. Start
  every worker session before the user leaves, have each write `.done` markers, and watch the markers, not
  chat events (`orchestration-and-environment.md`).
- **Price traps.** Catalog prices were wrong by up to 18x. One probe job per unmeasured model, then
  `ledger`, then the batch. The runner enforces this.
- **Paying for unused frames.** Trim before upscale, standard upscaler tier, plan utilization above 50%.
- **Magenta grade.** Blends run in planar RGB; `grade --test` on three frames before every full grade.
- **Overbright FX.** Flashes that read as the sun, petals that read as snow; measure FX positions on the
  footage instead of eyeballing them.
- **Weak or squashed sound.** Layer landings and hits (impact, debris tail, shake); check per-bus peaks
  before touching gains; ElevenLabs music sections of 3000 ms or more, written from the beats, never the
  template's sample plan.
- **Late SFX.** A file placed by its start lands late (QA measured 0.55 s and 21 frames). Place by the
  transient at the plate's own event frame, record `"onset"`, check with `qa-prescan.py events`.
- **Static cut.** A mostly-cel dialogue episode was rejected as static and far from the bar. Dialogue and
  emotion shots default to Omni (TTS aligned onto its mouth within 3 frames), at least 60% motion by
  runtime, and no still held over 1.5 s; `qa-prescan.py picture` flags holds.
- **Slow action rhythm.** FRONTIER ep02 cut at a mean 2.33 s (25 cuts a minute), held 0.65 of its runtime
  and showed 2.3 impact frames a minute; eight action references cut at 0.8-1.3 s (44-77 a minute), held
  0-0.36 and showed 3-22. Hold every action sequence against a reference with `measure-reference-cut.py`
  before the edit locks; band and craft notes in `gl-compositing-and-fx.md` and `edit-captions-and-render.md`.
- **Trusting a QA model.** Gemini samples about 1fps and is a weak ear; verify every claim with a strip or
  a measurement and record the verdict. A cut goes to two independent QA agents scoring a rubric of the
  user's verbatim notes and intent notes (`qa-rubric.md`) after `qa-prescan.py`, and ships when
  `qa-gate-check.py` passes both.
- **Layer-split jitter.** An overlay that holds still while its footage moves reads as a cut-out shaking.
  Use flat pushes on single paintings; put overlays inside `#cam`, riding `followCel` or `pinToTrack`.
- **Buried or generic ambience.** Beds 10-15 dB under the music failed "nghe ra môi trường" (you can hear
  where you are). Gate with `audit-mix-buses.py`, then send the beds stem to the user's ear; the numbers alone
  passed a scene he rejected. When AI beds sound generic, switch to real recordings in one shared space
  (`make-space-ir.py`, mixer `spaces`).
- **Delivery overshoot.** AAC re-encodes broke the -1.5 dBTP ceiling (up to +0.4 dBTP) and a 30.1 MiB file
  was refused by chat. Encode from the PCM mix behind the oversampled limiter, size the phone copy to 28 MiB,
  measure every file.
- **Stale bundle, dead render.** `render` does not bundle, and the 4 GB Node heap ran out on long scenes.
  `finish-scenes.py` bundles, checks freshness, sets 8 GB and renders one scene at a time.
- **Stacked fade.** The boot fades in from `EDL.fade.in`; a `fadeFromBlack` cue on top held frame 0 black.
- **Parallel writers.** Two jobs writing one `edl.json` or `mix-events.json` corrupted it. One writer per
  shared file; workers write proposals, the controller merges with a lock.
- **Lost state.** Everything lives in files; after a compaction run `status` first.
- **Deleting a lock by guess.** A stale render or merge lock blocked a round twice. Locks hold the owner's
  PID (`take_lock`); a dead owner's lock is reclaimed and logged, a live one is waited on. Never delete one
  by age or by hand before checking that PID.
- **Picking a taste call alone.** A stylized voice, a grade or an engine's look is the user's pick. Make
  labelled variants (`make-voice-variants.py`, `make-review-tiles.py`), send them, wait; record the pick.
- **SFX left behind by a retake.** One shot's gear cues stayed timed for its old take (2.25 s off in the
  source) and QA heard a stray rustle. After any retake or trim, retime the events anchored to that shot (`at_shot`)
  by the in-point delta through a mix proposal, then run `qa-prescan.py events`.
- **Hard-wired engines.** Not every user has the same local model, GPU or API. Scripts ask a role
  (`i2v-local`, `upscaler`, `asr`, `ai-judge`...) in `assets/templates/engines.json`, overridable per series;
  a new engine is a config entry (see `shot-tiering-and-model-routing.md`). Never write a machine path into
  a script; a CLI that PATH cannot run goes in `$ANIME_CLI_<NAME>`.
- **Quota blow-out.** 19 parallel agents hit the session limit mid-QA with no handoff. Cap at about 4
  (QA about 150k tokens each, builders about 240k), write the handoff early, resume agents with SendMessage.

## Cost and speed defaults

- Tier mix per 15s: T0 code 40-50% of runtime, T1 stills 20-30%, T2 Omni inserts 4-6, T3 at most one.
  Expect $2.6-3.4 cash; the measured film was $3.80 including design and tests. Dialogue scenes take their
  own mix (at least 60% Omni or H3 motion); quote it from measured prices (Omni $0.099/s, H3 $0.13/s).
  Quote an expected figure and a separate contingency, and count every route outside the ledger.
- Local H3 on one 16 GB GPU took about 5 minutes per 4 s take (17.3 GPU-hours for 112 shots): plan wall clock
  from that and pipeline per shot.
- Token savers: grep and read line ranges instead of whole engine files; read the script once into
  `work/beats.json`; numbers before images; prescan before QA; one QA pair per scene revision with short
  replies; fix shared defects before forking builders.
- Claude tokens were about 6x the cash in a run that wrote its code from scratch, and 63x on a multi-session
  episode whose edit phase alone cost $210; trace every phase so the split shows where. Reuse the engine and the
  scripts, keep tool output small, read a reference only when its phase starts, and use `context-pack` for
  subagents.
- Sonnet subagents only for self-contained work (sound design, one scene's FX cues), verified by
  measurement afterwards; several at once only when each owns its own output file (one sound designer per
  scene writing a proposal). Generation APIs run in parallel on their own.
- A 7.6-minute episode took three sessions and over 3,000 tool calls; images were 99% of what was read.
  The big savings are contact sheets under 300 KB and crops, the scripts below instead of retyped loops,
  and audio fixes as remuxes (a minute) instead of re-renders (about 17 minutes).
- One heavy job at a time (render, grade, long ffmpeg), in the background with completion notification.
  Render workers come from `preflight`.
- Check the Claude plan's 5-hour and weekly allowance before a long run and say if an episode needs more
  than one window.

## Done when

- Every gate in `episode.json` is approved and logged, with G0 and G1 approved by the user.
- `validate` passes for every scene; the master has exactly the EDL frame count.
- Every delivered file is measured (`renders/deliveries.jsonl`, or `loudness`): -14 LUFS plus or minus 1,
  true peak at or under -1.5 dBTP, anything sent to chat under 30 MiB.
- For an episode or a fix round: `qa-prescan.py` is clean, the bed gate passes, and both QA agents pass every
  rubric item (items marked "needs the user's ear" go to the user as clips).
- The QA checklist in `grade-master-and-qa.md` passes or each open item is listed in the report with a
  fix estimate.
- `ledger` shows measured spend within the ceiling; the report includes tokens per phase.
- Preview and report were sent to the user; `finish` wrote the run row with lessons and scores; story
  digest and continuity are updated for the next episode.

If a check cannot run (no network, missing tool), say so in the report and the reply; it does not count as
a pass.

## Resources

References (open the one for the phase you are in):

| File | Open when |
|---|---|
| `references/interview-and-scope-gates.md` | interviewing, writing the scope lock, running any gate, handling feedback |
| `references/series-bible-and-continuity.md` | creating characters and sets, before/after continuity across cuts, starting a later episode, recovering after compaction |
| `references/shot-tiering-and-model-routing.md` | assigning tiers, choosing models, estimating or defending a budget |
| `references/keyframes-and-ai-video.md` | generating sheets, keyframes, plates, Omni or Seedance clips; guiding a shot with a 3D blockout; shot joins by camera intent, reference reels, salvaging paid takes; trimming, upscaling, conforming |
| `references/gl-compositing-and-fx.md` | building GL sets, weather, light FX, camera and edit cues |
| `references/edit-captions-and-render.md` | editing the EDL, captions and subtitles, building and rendering; building the episode recap (OST music video) |
| `references/audio-voice-and-mix.md` | SFX, Foley from the picture (video-to-audio), music, voice source choice, alignment, the mix and its checks; dubbing an approved cut into another language (song version, beat-drive gate, on-screen text fit) |
| `references/action-sound-from-references.md` | writing a fight as an action plan; spotting and mixing an action scene against measured reference bands (hits, low end, density, music share, ducking) |
| `references/fish-drama3-voice-direction.md` | casting or directing a Fish Audio Drama 3 voice, plain vs directed text, OpenRouter vs native Fish routes, UTF-8 byte cost and paid-retry guards |
| `references/voice-takes-and-stylized-voices.md` | gating TTS takes (words, pitch, span), making robot or radio voices for the user to pick |
| `references/asset-catalog-and-lineage.md` | finding an asset by ID or shot, impact of a changed reference, pins, cleanup reports |
| `references/grade-master-and-qa.md` | grading, mastering, QA, scoring and retakes |
| `references/orchestration-and-environment.md` | delegation, machine load, quota, processes, credentials, network, shell traps |
| `references/report-and-telemetry.md` | tracing, ledger, tokens, the process report, `finish` and `insights`; catalog health (`observe`), context bytes per phase and DoD records (`dod`) |
| `references/knowledge-packs-and-film-spec.md` | craft knowledge on demand (`knowledge for <task>`), the FilmSpec story/shot contract and the DoD per level |

Scripts (paths relative to this skill's directory; every command has `-h`):

```bash
python3 scripts/anime-studio.py <command> ...    # setup, plan, footage, edit, finish and telemetry steps
python3 scripts/generate-media-via-multix.py <episode-dir> [--jobs a,b] [--kind video] [--dry-run] [--fetch] [--retry]
uv run --with numpy python scripts/build-audio-mix.py <episode-dir> [--scene sc01] [--peaks]
uv run --with opencv-python-headless --with numpy python scripts/chroma-key-cutout.py in.png --out-dir DIR
uv run --with opencv-python-headless --with numpy python scripts/track-plate-motion.py <scene-dir> [name:]<shot>[@x0,y0,x1,y1]... [--sheet DIR]   # FX and overlays ride a moving clip
uv run --with opencv-python-headless --with numpy python scripts/warp-plate-yaw-perspective.py in.png out.png
uv run --with onnxruntime --with pillow --with numpy python scripts/estimate-plate-depth.py model.onnx plate.png depth.png
uv run --with torch --with transformers --with pillow --with numpy python scripts/make-depth-maps.py <scene-dir>... [--force]   # <cel>.depth.png for depth cels
python3 scripts/draw-images-via-codex.py JOBS.json [--parallel 3]                # sheets and keyframes on the Codex plan quota
python3 scripts/finish-scenes.py <ep> --scenes sc01,sc02 --tag "{sc}-cut3-r1" [--video-from TAG] [--build-mix]   # bundle, render, grade, 720p, share, measure; one scene at a time
python3 scripts/assemble-episode.py <ep> --name ep01-cut3 --tag "{sc}-cut3-r1" [--part sc=tag]   # episode master, 720p, share, phone <30 MiB, TP-safe
python3 scripts/merge-mix-proposals.py <ep> work/<round>/mix-add-*.json [--dry-run]   # one locked, all-or-nothing merge
uv run --with numpy python scripts/audit-mix-buses.py <ep> <scene>... [--allow ids] [--stem beds T0 T1 out.wav]   # bed and masking gate
uv run --with numpy python scripts/qa-prescan.py picture|clips|audio|events <paths> [--max-hold 1.5]   # wedges, static holds, cuts in used ranges, clicks, late or chopped SFX
python3 scripts/qa-gate-check.py qa-a.json qa-b.json [--min-score 7]   # the two-agent pass rule; exit 0 only when both pass
uv run --with numpy python scripts/make-space-ir.py audio/ir/street.wav --preset street|plaza|hall|room|server   # IR for the mixer's spaces
uv run --with numpy python scripts/mix-shape-features.py ref.wav@60-120 ours.mp4@0-58   # reference vs ours: floor, peaks, bands, onsets/s, width
uv run --with numpy python scripts/measure-reference-cut.py ref.mp4 ours.mp4@40-70 --sheet DIR   # cut rhythm, impact frames, holds, hit placement vs a reference
uv run --with numpy python scripts/align-vo-to-omni.py omni.mp4 out.wav take*.wav [--omni-words stt.json]   # TTS take onto Omni's mouth, 3-frame gate
python3 scripts/retime-vo-line.py vo.wav out.wav '[[a,b,tempo],["gap",s]]' [--edl edl.json --line id]   # re-time a line, words follow
uv run --with numpy python scripts/gate-tts-takes.py take*.wav --text "line" --baseline-hz 210 [--engine asr-adapter]   # words, pitch vs speaker, speech span
python3 scripts/make-voice-variants.py --in flat=take.wav --group robot --out-dir DIR --name sc01-s06-L03 [--line TEXT]   # DSP variants + labelled reel for the user's pick
python3 scripts/generate-video-via-comfyui.py --image first.png --prompt TEXT --out clip.mp4 [--engine NAME] [--lora F] [--crf 12]   # local i2v; wall time and VRAM in the sidecar
uv run --with numpy python scripts/qa-shot-boundaries.py <scene-dir> [--strips DIR] [--chained-ratio 4.5]   # frames either side of each join vs its boundary mode
python3 scripts/make-review-tiles.py grid.jpg "clip.mp4|2.0|A: engine, approach" ... [--crop face]   # labelled comparison grid
python3 scripts/upscale-finished-scenes.py <ep> --tag "{sc}-cut3-r1" --out-tag "{sc}-cut3-hd" [--part sc=tag] [--test sc01:12.5:6] [--engine NAME]   # approved 720p parts to 1080p under a new tag, frame-checked, priced in the ledger; then assemble --tag "{sc}-cut3-hd"
python3 scripts/ai-shot-qa.py <ep> episode.mp4 --tag "{sc}-cut3-r1" [--engine NAME] [--collect]   # AI sound judge per shot group; leads to verify
```

On Windows, run Python as `python -X utf8` and append (never prepend) the uv directory to `PATH`; see
`orchestration-and-environment.md`.

`anime-studio.py` groups: setup (`preflight`, `init-series`, `init-episode`, `init-scene`, `init-clip`,
`status`, `gate`), plan (`validate`, `budget`, `prompt`, `context-pack`), footage (`trim`, `conform`), edit
(`build`, `build-edit`, `render`, `snapshot`, `subtitles`, `concat`), finish (`grade`, `sheet`, `strip`,
`loudness`, `onsets`, `lipsync`, `edge`), telemetry (`run-start`, `phase`, `trace`, `ledger`, `tokens`,
`report`, `finish`, `insights`), production (`validate-action`, `plan-action`, `salvage-plan`, `ref-reel`,
`continuity`, `chain`, `previz-camera`, `v2a-stale`, `assets`), engines (`engines ab-record` blind ratings
into `catalog/engine-ab.jsonl`, `engines measured` cost per accepted second per engine, `engines set-default`
only after an A/B the new engine wins; logged in `catalog/engine-defaults.jsonl`). A default steers only the
runners that read it (`i2v-local`, `upscaler`, `asr`, `ai-judge`, text-to-audio `sound-generation`); paid
video jobs take `model` from gen-plan.json, so an `i2v-cloud` default changes no paid job. Production commands
write proposals under `work/`; none edits the EDL, the mix or media.

The generation runner refuses a plan over the ceiling (`--allow-over`), holds batches of a model whose price
is not measured until one probe is billed (`--probe-ok`) and refuses a second Seedance shot per scene
(`--allow-seedance`). Use those flags only with the user's agreement.

Assets:

- `assets/templates/`: scope lock, series bible, character and set examples, style, continuity, story
  digest, gen-plan, music plan, mix events, mix-add proposal, QA prompts, QA rubric, price table, process
  report, `engines.json` (roles to engines), `voice-dsp-presets.json` (stylized voices).
- `assets/comfyui-workflows/`: API-format workflows for local engines (`_slots` mark what a script fills).
- `assets/film-engine/`: the shared GL and edit engine (`engine/`) and the per-scene HyperFrames template
  (`scene-template/`), copied into each series by `init-series`.

Script tests (no network, no paid calls):

```bash
uv run -q --with numpy --with pytest python -m pytest scripts/tests -q   # from the skill directory
```
