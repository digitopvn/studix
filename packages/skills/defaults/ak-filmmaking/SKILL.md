---
name: ak-filmmaking
description: "Produce long-form AI films (roughly 5-30 minutes) as a production graph: consistent characters, shot continuity, storyboards, animatics, audio-first lipsync dialogue, sound stems and cost-aware model routing."
when_to_use: "Use for narrative or episodic AI films; not for marketing or social videos, motion graphics or a single clip."
category: media
keywords: [filmmaking, long-form-video, character-consistency, storyboard, continuity, lipsync]
argument-hint: "[create|script|breakdown|bible|storyboard|animatic|render|audio|qc|assemble] [brief-or-project]"
metadata:
  author: agentkit
  version: "1.0.0"
---

# Filmmaking

Direct a long-form AI film as a controllable production pipeline, not one long
generation. A 10-15 minute film is typically 8-18 scenes and 70-150 shots of
3-10 s; shot boundaries follow narrative purpose and cinematic grammar, never a
provider's clip limit. The hard part is production state: identity, wardrobe,
props, dialogue timing, sound and cost across every shot.

<args>$ARGUMENTS</args>

## Outcome

A `films/<slug>/` production graph that is the single source of truth, plus the
artifacts the requested subcommand owns: screenplay, beat sheet, scenes and
shots, bibles with approved reference packs, storyboard, animatic, generated and
lipsynced shots, DX/FX/AMB/MX stems, QC records and the final cut. Every
intermediate artifact is preserved so any shot can be regenerated alone.

## Authority

May: write and edit the production graph and its media folders; run the bundled
`scripts/film.py`; call installed generation, voice, lipsync and media skills
for the stage the user requested.
Requires the user: spending on provider generation beyond the agreed budget
mode, promoting a new canonical identity reference, and publishing anything.

## Done when

- `scripts/film.py validate <film>` reports no errors for the stages claimed,
  and every warning is resolved or explicitly accepted by the user.
- The requested artifact exists on disk. A plan is never reported as a render;
  run `validate --check-media` before claiming produced media.
- Before any expensive video generation, the shot's storyboard (and keyframe for
  STANDARD and above) is approved and the full animatic has been reviewed.
- The final cut uses the dialogue master and separate stems, never the audio a
  video generator produced (`timeline --mode final` has no blockers).

## Constraints and known failure modes

- Continuity lives in the graph, not in prose or memory. Each shot reads the
  state carried along its `continuity_from` chain; an intended change is
  declared in `continuity_changes` with a reason.
- Identity comes from canonical reference packs. A newly generated frame never
  conditions a shot until it is explicitly promoted; identity drift is a QC
  failure to route, not a prompt to tweak.
- Dialogue is audio-first: master voice plus forced alignment exists before any
  lipsync-dependent shot is generated. Use reaction, over-the-shoulder, insert
  and cutaway coverage so visible lips carry only part of the dialogue.
- Keep DX, FX, AMB and MX separate until the final mix. Music comes from themes
  and motifs on a cue sheet, not one unrelated track per scene.
- Route each shot by its render class and the budget mode. A steam-over-a-cup
  insert never gets the hero close-up's model. Model names, prices, limits and
  capabilities change: use live provider evidence and record its source; never
  quote remembered figures as fact.
- A failed shot returns to the cheapest stage that fixes it (`film.py qc`);
  never regenerate a scene or the film for one bad clip.
- If the film does not work as an animatic, fix story and timing; more
  expensive video models will not save it.

## Subcommands

`create` runs the stages below in order and stops at the approval gates; the
others run one stage on an existing project. Load only the matching reference.

| Subcommand | Produces | Read |
|---|---|---|
| `create` | Project via `film.py init`, then each stage | `references/production-graph.md` |
| `script` | Screenplay and beat sheet | `references/screenplay-and-beats.md` |
| `breakdown` | Scenes, shots, coverage plan, continuity links | `references/scene-and-shot-planning.md`, `references/continuity-graph.md` |
| `bible` | Characters, wardrobe, locations, props, reference packs | `references/character-consistency.md` |
| `storyboard` | Storyboard stills and approved keyframes | `references/storyboard-and-previs.md` |
| `animatic` | First full-length cut on master dialogue | `references/animatic-workflow.md` |
| `audio` | Voice master, alignment, Foley, ambience, music cues | `references/dialogue-and-lipsync.md`, `references/sound-design-and-music.md` |
| `render` | Routed, compiled per-shot generations and lipsync passes | `references/model-routing-and-budget.md`, `references/prompt-compilation.md` |
| `qc` | Timestamped failures with their return stage | `references/quality-control.md` |
| `assemble` | Final timeline, remux of the dialogue master, mix | `references/assembly-and-delivery.md` |

## Tools

`scripts/film.py` is deterministic and standard-library only. Run it instead of
re-deriving its output: `init`, `validate [--check-media]`, `continuity`,
`prompt <shot>`, `route`, `coverage`, `cue-sheet`, `timeline --mode
animatic|final [--write]`, `costs` and `qc`. The machine contract is the JSON
schemas in `schemas/`; `assets/examples/rain-check/` is a complete valid
project to copy patterns from (JSON only: its media paths are declared, not
bundled, so `--check-media` reports them missing by design).

## Routing to adjacent owners

- Marketing, social, product or short promo video: use `ak-video`.
- Beat-synced HyperFrames motion graphics: use `ak-motion-video`.
- React/Remotion compositions: use `ak-remotion`.
- Voice, SFX and music generation: the installed voice/audio skill (for example
  `ak-elevenlabs`) owns provider syntax; this skill owns timing and stems.
- Image and video generation, lipsync tools, FFmpeg editing and mixing: the
  installed image-generation, video-generation and media-processing skills own
  their API and command syntax. If none is installed, report the missing
  capability rather than inventing calls.

## Evidence

Cite `film.py` output (findings, coverage, route, costs, QC timecodes) and the
files produced. Report estimated versus recorded cost only from recorded
evidence, and name any stage that was planned but not executed.
