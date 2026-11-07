# Quality control

QC produces timestamped, actionable failures, not a 1-10 score. Record each
failure on the shot's `qc` record with a category, `at` (and optional `end`)
seconds from the shot start, and a concrete note; set the shot to QC_FAILED.

```bash
python3 scripts/film.py qc films/<slug>
```

lists every failure with its film timecode, the stage to return to and the
action, so a failed shot goes back only as far as needed.

## Categories and return stage

| Area | Categories | Return to | Fix |
|---|---|---|---|
| Character | `identity`, `hair`, `accessories`, `wardrobe` | STORYBOARDED | Fix the keyframe from the canonical pack, re-approve, then rerender |
| Continuity | `prop`, `spatial`, `lighting`, `location` | STORYBOARDED | Fix graph and keyframe first |
| Video | `morphing`, `anatomy`, `camera`, `physics`, `temporal_artifact` | APPROVED_FRAME | Regenerate video only from the approved frame |
| Lipsync | `lipsync_drift`, `lipsync_offset`, `pause_motion` | GENERATED (dedicated pass) or APPROVED_FRAME (native) | Rerun the dedicated pass and keep the video; a native-lipsync shot is regenerated from its frame or routed to a dedicated pass |
| Timing | `dialogue_timing` | PLANNED | Fix audio or shot timing before any generation |
| Audio | `pronunciation`, `audio_mix`, `music`, `sfx_timing`, `ambience_seam`, `loudness` | audio | Fix the stem; no video regeneration |
| Narrative | `pacing`, `redundant`, `coverage` | edit | Solve in the cut or add coverage |

## What to inspect

- Character: identity against the canonical front and three-quarter views, age,
  face structure, hair, wardrobe, accessories.
- Continuity: prop state and hand, screen side and direction, lighting and time
  of day, location, the previous and next shot played together.
- Video: morphing, anatomy, camera move versus spec, physics, flicker.
- Lipsync: speech start and end, behaviour in pauses, visible alignment and
  drift over the line, obvious phoneme mismatch on close-ups.
- Audio: pronunciation, clarity, ambience seams, SFX onset against its sync
  event, music masking dialogue, loudness.
- Narrative: pacing, redundant shots, reaction coverage, visual variety,
  emotional progression.

Inspect representative frames and the audio of the actual file with the
installed multimodal or media-processing skill; do not pass a shot from its
prompt or thumbnail alone.

## After QC

Passed shots get `qc.status: passed` and move to APPROVED. A failed shot moves
to QC_FAILED with `qc.status: failed`. To rework it, mark the failed generation
`discarded` (it stays as history), move the shot back to the return stage, and
set `qc.status: pending`; `qc` only lists failures while the record is `failed`. `validate` rejects a QC_FAILED
shot without a failure record, an APPROVED shot without a passed record, and a
failure timestamp past the shot's end.
