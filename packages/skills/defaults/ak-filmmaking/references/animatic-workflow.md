# Animatic workflow

The animatic is the first full-length version of the film and the mandatory
cost-control gate before final video generation:

```text
storyboard stills (approved keyframes where they exist)
+ master dialogue
+ temp ambience, temp Foley/SFX, temp music
```

## Build it

```bash
python3 scripts/film.py timeline films/<slug> --mode animatic --write
```

This writes `animatic/timeline.json` (shot placements, stems, blockers) and
`animatic/video.ffconcat` (stills with their durations, paths relative to the
file). Blockers list shots without a storyboard frame, dialogue that is not yet
master, and cues without a file. Render the picture track and lay the stems
with the installed media-processing skill; keep the stems separate in the
animatic project too.

Dialogue must be master here because the animatic is where timing is judged; a
temp voice changes length and invalidates every cut decision built on it.

## Review with the user

- Pacing and scene length against `target_duration_minutes`.
- Dialogue length, joke and reveal timing, held silences.
- Coverage: where a reaction shot or cutaway should carry a line
  (`film.py coverage` shows visible-lipsync versus off-screen dialogue).
- Redundant shots to cut before they cost a generation.
- Where silence is better than music.
- Whether the story works at all.

## After review

Edit the graph: retime `duration_target`, reorder or cut shots, move cue
`start` values, add coverage. Rerun `validate` (it flags dialogue running past
a scene's cut) and rebuild the animatic until the user signs off. Record the
sign-off in `project.json`:

```json
"animatic": {"status": "approved", "approved_at": "2026-10-05"}
```

`init` starts it as `pending`; until it is `approved`, `validate` rejects any
live (candidate or selected) generation on a non-PREVIS shot, whatever the
shot's state. An approved animatic also requires every shot to have a frame
(an approved keyframe or a storyboard that is not rejected). Only then start
routed rendering.
Set it back to `pending` when a restructure invalidates the reviewed cut.

If the film does not work as an animatic, rewrite or restructure; better video
models do not fix story or timing problems.
