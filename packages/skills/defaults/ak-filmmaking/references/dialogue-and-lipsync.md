# Dialogue, audio conditioning and lipsync

Dialogue audio is the timing source of truth before any lipsync shot exists.

```text
screenplay dialogue -> voice direction -> master voice -> forced alignment
-> sentence/word timestamps -> shot timing -> lipsync conditioning
```

## Dialogue master

- One DX cue per line or short exchange in `audio/cues.json`: `character`,
  `text`, `direction`, `file`, `alignment`, `status`, and its placement as
  `scene_id` + `start` seconds on the scene timeline.
- Generate voices with the installed voice skill (for example `ak-elevenlabs`),
  which owns voice selection, settings and API syntax. Record the opaque voice
  identifier in the character bible's `voice.voice_ref`.
- Status moves `planned -> temp -> master -> approved`. The animatic needs
  master DX; lipsync-dependent generation needs master DX plus alignment.
- Store the master files under `audio/dialogue/`, separate from anything a
  video generator returns.

## Forced alignment

Write `audio/alignment/<cue_id>.json` (see `schemas/alignment.schema.json`):
sentence spans are required; word spans and silences are optional detail.
Produce it with an installed alignment/transcription capability or the
media-processing skill; never hand-estimate timestamps for a lipsync shot.

Keep phoneme-level data out of prompts. `film.py prompt` uses sentence timing
clipped to the shot; finer alignment stays available for QC and lipsync tools.

## Audio as conditioning

Derive performance constraints from the master: pace, pauses, breaths, energy
and emotional delivery shape the shot's `action` and `emotion`. For sound-locked
physical events (cap pop, clap, door slam, footstep) place an FX cue with a
`sync_event` naming the shot; `validate` checks the onset lands inside it.

## Which shots get lipsync

Set `visible_speakers` only where a mouth is readable, then `lipsync`:

| Value | Use |
|---|---|
| `none` | No readable speaking mouth (wide, back, reaction, insert, cutaway) |
| `native` | Provider generates lips from the audio reference |
| `dedicated` | A separate lipsync pass on the selected generation |

`validate` errors when a visible speaker talks over a shot with `none`, and
warns when the budget policy recommends a dedicated pass:

| Budget | Dedicated pass recommended for |
|---|---|
| low | HERO close framings |
| balanced | CHARACTER_CRITICAL and HERO close framings |
| quality | every visible speaking shot of STANDARD and above |

## Speaking-shot rules

1. The master dialogue is authoritative; bind it to the shot explicitly
   (`film.py prompt` lists each audio input with its trim and shot interval).
2. Preserve pauses: no mouth motion outside the bound intervals.
3. Avoid strong head turns or occlusion over critical lines unless intended.
4. Try native lipsync first where the route allows; run the dedicated pass
   with the installed lipsync tool for close-ups and hero shots that need it.
5. After any visual lipsync, remux the original dialogue master in assembly;
   never ship the waveform a generator recreated.

## Coverage reduces lipsync

`film.py coverage` reports total dialogue seconds, the share carried on
visible lips, and each off-screen segment. Lines that play over reactions,
inserts and cutaways cost no lipsync and hide sync errors; plan them in
breakdown, confirm them in the animatic.
