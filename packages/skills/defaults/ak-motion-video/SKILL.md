---
name: ak-motion-video
description: "Produce beat-synced 1080p motion-graphic videos in HyperFrames (HTML + GSAP) with AI voice-over, Vietnamese karaoke captions, SFX and music in ~70 styles (Apple-like, Vox-like collage, Swiss, Nike-like)."
argument-hint: "[brief or project] [--poor]"
when_to_use: "Use to make or restyle launch, changelog or explainer videos and 1:1 or 9:16 Reels cuts, e.g. 'làm video motion graphic giới thiệu release'; not for talking-head edits, Seedance/Veo or React/Remotion."
category: media
keywords: [motion-graphic, narrative-arc, hook, explainer, collage, vox, style-profile, style-composition, video, hyperframes, gsap, launch-video, voice-over, captions, karaoke, beat-sync, elevenlabs, gemini-tts, multix, spider-verse, comic, keynote, social-encode, motion-craft, reframe, vertical-video, 9x16, square, creative-direction, tasteful, poor]
license: Proprietary; includes MIT-licensed third-party material, see LICENSE.txt
metadata:
  author: agentkit
  version: "1.6.0"
  attribution: "First-party AgentKit skill, first published as bestagentkits/motion-video-skill; story, shot and collage craft adapted from Alisa0808/vox-director (MIT)"
  upstream: "github.com/bestagentkits/motion-video-skill"
  upstream_sha: "a73702b893a3a5462804b5b844c6080e76f69275"
  imported_at: "2026-09-25"
---

# Motion video

Make a 1920×1080 30 fps motion-graphic video where the scene cuts land on the
music's beats, reveals land on spoken words, and the audio is broadcast-clean.
The workflow is fully scripted: facts → script → multix audio → forced
alignment → beat grid → bar-spliced music → timeline + mix → HTML composition →
lint/check/snapshot → render → remux → social encode → optional 1:1 / 9:16
editions.

## Production bar

Work as an exceptional motion designer delivering a real production piece, not a
demo or prototype. Every scene has a focal point, depth, overlapping
choreography, anticipation and follow-through, micro-motion through its holds,
and a transition that carries into the next scene. The juice (slams, smears,
squash and stretch, impact frames) scales with the base style's energy and never
breaks its constraints. `references/motion-craft.md` holds the principles, the
technique cookbook, the demo tells to replace and a per-scene director's pass.

## Modes

- **Default:** the main session is the operator. It pins the outcome, owns the
  script, style and direction brief, and runs the work as waves of parallel
  sub-sessions (subagents only where sessions are unavailable), each with a
  model and effort sized to its piece: cheap scouts for facts, the strongest
  tier for creative direction and the isolated taste review, mid-tier workers
  for sound design, timeline, art and one scene (or a run of scenes) each, and
  an assembler that splices the scene fragments and renders. Workers own
  disjoint files; the operator integrates and verifies.
- **`--poor`:** one session and no sub-sessions or subagents, with lean reads,
  a compact brief and one review round, for the lowest token spend. It never
  skips a check.
- **`--from-recording`:** the voice is the user's own recording (talking-head
  takes, a narrated screen share). The motion graphics carry the screen and
  the speaker is a webcam picture-in-picture. Transcript, EDL, timeline, mix,
  PiP finish and shorts all run from bundled scripts
  (`references/recording-pipeline.md`), so the project holds data, not
  pipeline code. It combines with the default mode or `--poor`.

`references/orchestration.md` holds the dispatch rules, the per-piece model,
effort and file-ownership table, the waves, the scene-fragment contract, the
brief and review formats, quota and machine limits, the degrade rule, and what
`--poor` trims.

## Styles

Every look is a style profile: a compact motion-design grammar covering
palette, typography, layout, material, texture, camera, transitions, pacing,
beat response, UI choreography, diagrams, character motion, captions and sound.
`references/styles/index.yaml` lists them, one line each. Brand names
such as Apple, Nike, Linear or NVIDIA are aliases that lead to a canonical motion
language (for example Apple-like leads to `cinematic-product-launch`). The output
never uses a brand's logos, fonts or assets.

- **One style:** name it and use that profile as the base, e.g. "comic style"
  gives `comic-multiverse` and "Apple-like" gives `cinematic-product-launch`.
- **Mixed:** keep one base and borrow individual dimensions from other styles
  for particular scenes, e.g. an Apple-like base with Linear-like UI demos,
  blueprint diagrams and a Nike-like finale. `references/style-system.md` holds
  the grammar and the deterministic resolution rules.
  `scripts/resolve-style.py` resolves the mix into a per-scene table.

Three styles also have a detailed reference taken from real work, and their demo
shows the finish to aim for:

| Style id | Detailed reference | Public demo | Feel |
|---|---|---|---|
| `comic-multiverse` | `references/style-comic-spiderverse.md` | [Dewee v3.34 comic edition](https://x.com/goon_nguyen/status/2103332658151555231), the 151 s social encode | loud, playful, hand-made |
| `glass-keynote` | `references/style-glass-keynote.md` | the 144 s edition of the same release | premium, calm, clear |
| `cinematic-product-launch` | `references/style-cinematic-product-launch.md` | none yet; rules distilled from a published premium product-video framework | minimal, exclusive, continuous |

The working projects of those editions are not bundled, because the generated
voice-over, music and SFX are large and provider-licensed. Build every new video
from `assets/templates/index-skeleton.html` plus the resolved style.

## Scope

This skill handles:
- New videos in any of the styles, restyles of an existing video as a separate project,
  and partial reworks (new music, re-timed drops, re-mix, re-render, social encode).
- Audio through the `multix` CLI: Gemini TTS voice, ElevenLabs SFX, ElevenLabs
  Music composition plans, ElevenLabs forced alignment.
- Generated still art (collage, print, poster looks) and anchored photos of a
  person or product through `multix` image generation and editing, baked to PNG
  layers and animated in GSAP.

This skill does NOT handle:
- Generative text-to-video footage (use `ak-video` or `multix`
  Seedance/Veo directly).
- React/Remotion compositions or generic HyperFrames questions (use `ak-hyperframes` or
  `ak-remotion`).
- Publishing to social accounts: produce the file and let the user post it.

## How to work

1. Run the preflight first: `python -X utf8 scripts/doctor.py <project>` (add
   `--mode recording` for recordings). It checks the shell, the Python
   modules, ffmpeg and ffprobe, node, the pinned HyperFrames and UTF-8 output.
   It writes `data/env.json` and prints one brief line. Fix every failed
   required check, and put the brief line in every worker's brief.
2. Pin the outcome before touching files: topic and sources, style (a base
   from `references/styles/index.yaml`, plus layers only if the brief asks for
   different looks in different parts; record them in `data/style.json`, and
   lock the base's palette and BPM band), duration, voice language (English VO +
   Vietnamese captions by default), ending, and a signature only if the user
   gives its text (there is no default). Ask only if the style or
   the facts source is unknown; when only the style is open, run the bake-off
   in `references/style-system.md` instead of asking in the abstract. Pick
   the arc, hook and ending and size the scenes with
   `references/story-and-shots.md`, then show the beat map (arc, hook, one
   line per scene) once before any paid audio and continue unless the user
   objects; skip it in non-interactive runs or when the user supplied the final
   script. Pick the mode (`references/orchestration.md`):
   by default get the direction brief before the voice-over is generated, and
   start the fact scouts, bake-off and sound design in parallel where their
   inputs allow.
3. Create `assets/videos/<slug>/` (never overwrite a finished edition) and a plan
   under `plans/` following the repo convention. Copy the templates from
   `assets/templates/` of this skill: `scripts/*.mjs`, `data/*.example.json`
   (rename to `.json`; `style.json` is optional for a single style), `hyperframes.json`, `index-skeleton.html` as
   `index.html`, plus `scripts/fit-beat-grid.py`.
4. Follow `references/production-pipeline.md` step by step (or
   `references/recording-pipeline.md` with `--from-recording`). Each step writes a
   file the next one reads, so do not reorder them.
5. Get the music right with `references/audio-and-beat-sync.md`: fit the grid,
   splice bars so the drops land where the script needs them, verify the splice,
   and measure the voice/music balance.
6. Build the composition with `references/composition-contract.md` and the base
   profile, starting from `assets/templates/index-skeleton.html`. With layers,
   run `python scripts/resolve-style.py resolve data/style.json --script data/script.json`,
   paste its per-scene table into the plan, and take each dimension from the
   style the table names. Composition never changes the contract, timing, mix or
   render checks. When a
   scene type repeats (stats, diagrams, charts, terminal, graph, outro), follow
   the demo's choreography for that scene instead of inventing a new one.
   Give each scene the shot from the beat map (size, camera move, cut-in) and
   never repeat a camera move in adjacent scenes. When the style needs printed
   or hand-made imagery, or the user supplied a photo to place, bake art layers
   first with `references/generated-art.md` (multix, through the local Codex
   CLI when it is installed). Choreograph with `references/motion-craft.md`,
   run its director's pass on every scene, and review motion on draft contact
   sheets before the final render. In the default mode builders write one
   `scenes/<sid>.scene.html` per scene (stubs from `scripts/scaffold-scenes.py`),
   query timing with `scripts/tl.py`, and fast-check every few scenes with
   `scripts/assemble.py --scenes a..b --tag tmp` and `scripts/validate.py`.
   Known pitfalls are in `references/composition-contract.md`.
7. For square or vertical editions, follow `references/reframe.md`: pick the
   full-video edition (`scripts/reframe.py`) or shorts as scene-range clips
   (`shorts.py`), pick short candidates while planning, write the
   `html[data-ratio]` overrides in the master while building, audit them with
   `scripts/audit-ratio-scope.py`, and check them with
   `scripts/check-bounds.mjs`. Audio and timing are reused as-is. Shorts are
   produced only after the user approves the master.
8. Finish only when every check in "Done when" passes; report measured numbers,
   not impressions.

Keep credentials inside multix's own config. Never print API keys or copy them
into project files, plans or reports.

## Done when

- `hyperframes lint` and `check` pass; snapshots of every scene were reviewed.
- Every scene passed the director's pass in `references/motion-craft.md`.
- Each requested 1:1 / 9:16 edition passes the same lint, check, ffprobe (its
  frame size), loudness and blackdetect checks.
- `verify-arrangement.py` reports every segment within ±2 ms and
  `measure-mix-balance.py` shows the music ~4–6 dB under speech.
- ffprobe: 1920×1080, 30 fps, expected duration, AAC 48 kHz stereo;
  ebur128 ≈ −14 LUFS with peak ≤ −1 dBFS; blackdetect finds nothing outside fades.
- `build-timeline` printed no clip/overlap/missing-word warnings.
- With `--from-recording`: `check-edl.py` passes, and each part and short
  passes `validate.py` and `probe.py` (frame size, 30 fps, loudness,
  blackdetect).
- On-screen facts trace to the sources collected in step 1.
- No two adjacent scenes share a camera move, and no framing holds past ~8 s.

## Resources

- `references/production-pipeline.md`: every command from scaffold to social
  encode and studio preview, plus the rebuild table.
- `references/audio-and-beat-sync.md`: voice, SFX cues, music plans,
  bar-splice arrangement, anchors, mix numbers and the ducking pitfall.
- `references/composition-contract.md`: TIMING shape, helpers, determinism,
  scene windows, captions, mascot, renderer limits, signature.
- `references/orchestration.md`: operator and parallel sub-sessions, model and
  effort per piece, waves, scene fragments, brief and review formats, quota,
  degrade, `--poor`.
- `references/motion-craft.md`: production bar, juice budget by energy,
  principles, technique cookbook, demo tells, director's pass, contact-sheet review.
- `references/reframe.md`: full-video editions, shorts as scene-range clips,
  9:16 safe areas for the webcam-PiP layout, the ratio-scope audit and the
  quick ffmpeg fit.
- `references/recording-pipeline.md`: `--from-recording` step order, with the
  inputs and outputs of every step from transcript to shorts.
- `references/captions-vi.md`: the Vietnamese caption-editing brief and
  criteria (terms, proper nouns, line breaks).
- `references/story-and-shots.md`: narrative arcs, hook patterns, scene count
  by duration, endings, shot sizes, camera moves and the anti-monotony rule.
- `references/generated-art.md`: multix image routes (Codex driver or Gemini),
  the five-part image prompt, chroma cut-outs, photo anchoring, collage assembly.
- `references/style-system.md`: dimensions, scene types, composition spec,
  resolution rules, brand-alias policy, and how to add a style.
- `references/styles/index.yaml`, generated: one entry per style.
  `references/styles/profiles/<id>.yaml` holds each full profile.
- `references/style-glass-keynote.md` / `references/style-comic-spiderverse.md` /
  `references/style-cinematic-product-launch.md`: detailed tokens, layers,
  components and caption look for the three reference styles. The cinematic one
  adds the brand lock, BPM-by-mood bands and the SFX subtraction audit.
- `scripts/resolve-style.py find|resolve|validate|index`: look up a style from
  words, resolve a composition into per-scene sources, and validate the catalog.
  Needs PyYAML.
- `scripts/reframe.py <project> --ratio 1x1|9x16 [--out dir]`: writes a
  square or vertical edition next to the master (hard-linked assets) and warns
  about layout that still assumes 1920×1080. Standard library only.
- `scripts/doctor.py [project] [--mode tts|recording]`: preflight; writes
  `data/env.json` and the brief line.
- `scripts/tl.py <project> list|scene|words|short|part`: query the timeline
  instead of reading `data/timeline.json`.
- `scripts/scaffold-scenes.py <project> [--scenes a..b]`: stub fragments.
- `scripts/assemble.py <project> [--scenes a..b] [--tag T] [--ratio R] [--title T] [--tail S]`:
  splice fragments into `builds/<tag>/`, rebased for parts and shorts.
- `scripts/validate.py <build>`: lint and check with a one-line summary.
- `scripts/probe.py <file>... [--expect WxH --fps N --loudness --black]`: render
  checks; reports "not rendered" instead of crashing.
- `scripts/contact-sheet.py <render> --timeline <file>`: one sheet per scene,
  ≤ 1400 px wide.
- `scripts/audit-ratio-scope.py <project> [--ratio R]`: ratio overrides stay
  scoped; required before committing them.
- `scripts/check-bounds.mjs <build>`: headless safe-area and finish check every
  0.05 s; needs the `playwright` package.
- `scripts/fit-beat-grid.py <music> [--min-bpm N --max-bpm N]`: BPM, BEAT0 and a
  per-bar kick/energy table.
- `scripts/verify-arrangement.py <project> [--tolerance-ms 2]`: splice lag per
  segment; exits 1 on drift.
- `scripts/measure-mix-balance.py <project>`: music under speech vs in gaps,
  from `build-timeline.mjs --stems`.
- `scripts/tests/`: `test_style_system.py` needs PyYAML; `test_audio_tools.py`
  needs ffmpeg, numpy and scipy; the recording, assemble and preflight tests need
  ffmpeg; the `check-bounds` cases in `test_audits.py` need node and playwright
  and skip without them; `test_reframe.py` needs nothing else. Run them with
  `python -m pytest scripts/tests` on the Python that has those modules.
- `assets/templates/`: project scripts (`generate-audio-assets`,
  `align-voiceover`, `arrange-music`, `build-timeline`), example data files and
  the composition skeleton.
- `assets/templates/recording/`: the `--from-recording` steps (`transcribe`,
  `segments`, `apply-edl`, `check-edl`, `build-timeline`, `mix`, `finish`,
  `shorts`), run from the skill with the project as their first argument, and
  their example data files.
