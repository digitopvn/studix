# Production graph

The graph under `films/<slug>/` is the only place production state lives. The
LLM never carries continuity in conversation memory: it reads the graph, edits
it, and runs `scripts/film.py validate` after every change.

## Layout

```text
films/<slug>/
  project.json            title, budget_mode, fps, aspect, currency, scene order, style,
                          animatic sign-off
  screenplay.md           human-readable script; scene headings = scene IDs
  beat-sheet.json         beats -> scenes, purpose, dramatic question, music theme
  bibles/
    characters/<id>.json  identity_version, hair, accessories, reference pack
    characters/<id>/      front.png, three_quarter_left.png, ..., expressions/
    locations/<id>.json   kind=location + reference images
    props/<id>.json       kind=prop
    wardrobe/<id>.json    kind=wardrobe, owned by one character
  scenes/<S01>/scene.json            location, time of day, cast, wardrobe, props, shot order
  scenes/<S01>/shots/<S01_SH001>/    shot.json, references/, keyframes/, generations/, approved/
  storyboard/  animatic/  renders/  qc/  final/
  audio/cues.json                    every DX/FX/AMB/MX cue on the scene timeline
  audio/dialogue/ alignment/ ambience/ sfx/ music/ stems/
```

Bible file names are the ID in kebab case (`MAI_01` -> `mai-01.json`). All
paths inside JSON are relative to the film root. `schemas/*.schema.json` is the
exact contract; `assets/examples/rain-check/` shows every field in use.

## Stable IDs

| Entity | Pattern | Example |
|---|---|---|
| Scene | `S` + 2-3 digits | `S03` |
| Shot | `<scene>_SH` + 3 digits | `S03_SH007` |
| Character, location, prop, wardrobe, cue, reference image | `UPPER_SNAKE` | `MAI_01`, `CAFE_INTERIOR_01`, `DX_MAI_003`, `CHAR_MAI_FRONT` |
| Beat | `B` + digits | `B02` |

IDs never change once used. Renumbering shots breaks generation history; insert
`S03_SH007` between existing shots by editing the scene's `shots` order instead.

## Shot lifecycle

```text
PLANNED -> STORYBOARDED -> APPROVED_FRAME -> GENERATED -> (LIPSYNCED) -> APPROVED -> ASSEMBLED
                                     QC_FAILED -> cheapest return stage
```

`validate` enforces the gates: a storyboard exists from STORYBOARDED; it is
approved (plus an approved keyframe for STANDARD, CHARACTER_CRITICAL and HERO)
from APPROVED_FRAME; exactly one `selected` generation from GENERATED, with
master and aligned dialogue for every visible speaker; a finished dedicated
lipsync pass from LIPSYNCED; a passed QC record for APPROVED and ASSEMBLED.
No shot except PREVIS records a live (candidate or selected) generation before
its frame is approved and `project.animatic.status` is `approved`, whatever its
state says.
Discarded generations stay in `generations` as history and cost evidence.

## The `create` flow

1. `python3 scripts/film.py init films <slug> --title "..." --minutes 12 --budget balanced`
2. `script`: screenplay and beat sheet. Review the story with the user.
3. `breakdown`: scenes, shots, continuity links, render classes.
4. `bible`: reference packs; the user approves canonical identities.
5. `audio`: voice direction, dialogue master, forced alignment, temp beds.
6. `storyboard`, then `animatic`. Gate: the user signs off the animatic and
   `project.animatic.status` becomes `approved`.
7. `render` shot by shot in routed order, then `qc`; loop failed shots only.
8. `assemble`: final timeline, dialogue master remux, stem mix.

Run `validate` between stages. Each stage's reference owns its detail.

## Validator findings

Errors block the next stage; warnings need a decision (fix, or record that the
user accepted it). Findings carry a film timecode (`HH:MM:SS.mmm`) where they
apply to a point on the cut, so a reviewer can scrub straight to the problem.
`--json` gives machine-readable output for automation.
