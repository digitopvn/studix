# Scope lock (G0): <series> <episode>

The contract signed before anything is paid for. The agent fills it from the interview, proposes the best
version it can, and the user approves or edits it. `--auto` skips later gates, never this one or G1.

## Story

- Logline (one sentence):
- Length: target __ s (tolerance +/- 10 %), __ scenes
- Format: 16:9 1920x1080 at 24 fps (or __), delivery mp4 + preview (~25 MB) + srt/vtt
- Spoken language: __ ; caption languages: __ (live karaoke captions: yes/no)
- Tone and references (titles, scenes, timestamps):

## Characters and sets

| Character | Look anchors (3-5) | Handedness / props | Voice (provider, voice, language) | Status |
|---|---|---|---|---|
| | | | | new / from bible |

| Set | Description and light | Camera rule | Status |
|---|---|---|---|
| | | real perspective, never flat side-on | new / from bible |

## Beat sheet

| # | Scene/shot | Time | Beat (what the viewer must understand) | Acting / emotion | Camera | Tier | Lines |
|---|---|---|---|---|---|---|---|
| 1 | sc01/s01 | 0.0-2.0 | | | | T0 | |

Tiers: T0 code/GL (sets, weather, light FX, camera moves, title), T1 cel or still image with GL motion,
T2 Omni first/last-frame insert (3 s minimum, trimmed to the beat), T3 Seedance (one per scene at most, only
for full-body action no other tier can sell).

## Dialogue

| Shot | Speaker | Line (spoken language) | Translation | Delivery note |
|---|---|---|---|---|

## Sound

- Music: style, sections, where it drops out
- Signature SFX: impacts, whooshes, ambience beds
- Mix target: -14 LUFS integrated, -1.5 dBTP

## Budget

- Cash ceiling: $__ (estimate from `anime-studio.py budget`: $__; tier mix: T0 __ s, T1 __ s, T2 __ s, T3 __ s)
- Expected cash per film second: $__
- Retake allowance: __ takes per T2 shot, __ for T3

## Mode and authority

- Mode: gated (stop at G0-G4) / `--auto` (stop at G0 and G1 only, then deliver)
- The agent decides alone: shot order inside a beat, timing within +/- 0.5 s, SFX choice, grade details,
  retakes inside the allowance, swapping a T2 shot down to T1 when it fails QA twice
- The agent must ask: any story or dialogue change, a new character or set, a tier upgrade to T3, spending
  above the ceiling, a change of length beyond tolerance

## Non-goals

-

## Acceptance criteria

- [ ] Every beat in the sheet reads clearly without the captions
- [ ] Characters match the bible (anchors, handedness, props) in every shot
- [ ] No floating figures, cut limbs or blades, flat side-on staging
- [ ] Lines in sync (measured median lag <= 2 frames), captions on time
- [ ] Mix at target loudness, no clipped peaks
- [ ] Cash within the ceiling; process report delivered with the film

## Sign-off

- Approved by: __  on __  (record with `anime-studio.py gate <episode> G0 approved --note "..."`)
