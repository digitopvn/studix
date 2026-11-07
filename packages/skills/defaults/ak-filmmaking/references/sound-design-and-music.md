# Sound design and music

Keep four stems separate from the first temp track to the final mix:

| Stem | Content | Folder |
|---|---|---|
| `DX` | Dialogue master + alignment | `audio/dialogue/`, `audio/alignment/` |
| `FX` | Foley and sound effects | `audio/sfx/` |
| `AMB` | Ambience beds | `audio/ambience/` |
| `MX` | Music cues | `audio/music/` |

Every cue lives in `audio/cues.json` with its stem, scene placement, status and
file. Flattening stems early makes dialogue fixes, music changes and loudness
work impossible without regenerating everything.

## Foley and SFX

Prefer separate, deterministic assets for events the audience must feel:
footsteps, doors, glass, cloth, keyboard, phone, vehicles, impacts. Generated
video audio is never the source. For a sound that must land on a visual event,
add `sync_event: {shot_id, description}`; `validate` checks the onset falls
inside that shot, and `film.py cue-sheet` lists all sync events for the editor.

## Ambience

Build scene beds (`AMB_CAFE_ROOM`, `AMB_CITY`, `AMB_PEOPLE_MURMUR`) and mark
them `loop: true` when they must cover long scenes. Listen for loop seams at the
cue's length and at scene transitions; seams are an `ambience_seam` QC failure
fixed in the mix.

## Music

Write themes and motifs, not one unrelated track per scene:

```text
THEME_A_MAIN  THEME_A_TENSION  THEME_A_EMOTIONAL  THEME_B_ANTAGONIST
```

Beats name a `music_theme`; MX cues carry the `theme` ID and a `direction`.
`film.py cue-sheet` produces the music cue sheet (theme, in/out timecodes,
status) and a per-stem inventory. Decide in the animatic where silence plays
better than music and where music must duck under dialogue.

Generation of voice, SFX and music belongs to the installed audio skill (for
example `ak-elevenlabs`); this skill decides what each cue is, where it sits and
what status it has.

## Mix

The final mix (loudness target, ducking, stem export) runs through the installed
media-processing skill from the final timeline's separate stem lists. Check
dialogue clarity against music masking and keep the stems exported alongside
the master for later fixes.
