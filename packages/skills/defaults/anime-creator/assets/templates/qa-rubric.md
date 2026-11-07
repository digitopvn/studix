# <SERIES> <EPNN> <cut>: QA rubric

<!-- Copy to plans/<plan>/qa-rubric.md for each cut or batch. Two QA agents score it independently. Keep the
user's words verbatim in A; never paraphrase them into something easier to pass. -->

Two independent QA agents score this render. Every PASS or FAIL cites evidence: a file name, a timestamp or
frame, or a measurement. Do not judge on vibes. The user's ear and eye outrank any AI judge. When Gemini hears
something the measurements do not support (or the reverse), write "needs the user's ear" instead of FAIL.

Verdicts per item: `PASS`, `PASS-TRIM` (passes once a stated trim or cut is applied) or `FAIL`. A score under
7/10 on any asset is a FAIL.

## A. The user's feedback (date, verbatim)

> <paste every message about this cut, unedited, in the user's language>

| # | Timestamped note (verbatim) | Scene / time | Passes when |
|---|---|---|---|
| A1 | "<note>" | scNN mm:ss | <a measurable condition> |

General bar (from earlier rounds): <e.g. Netflix/ufotable polish; with eyes closed you still know where you are>.

### Intent notes (accepted trade-offs)

Each note gives the reason, the frames, and what the viewer should read there. QA rejects an "intentional"
claim that has no note, and builders never label a cover-up as intentional.

| Item | Frames | Reason | What the viewer reads |
|---|---|---|---|
| <e.g. sc05 s13 freeze> | <f1520-1552> | <hides an Omni morph; the beat is a held breath> | <a beat of stillness before the strike> |

## B. Criteria

Run `qa-prescan.py` and `audit-mix-buses.py` first, and attach their output. Agents judge, they do not measure.

### Sound

| # | Criterion | How to check |
|---|---|---|
| S1 | Each location has at least 3 bed layers (air or room tone, mid texture, detail) plus spot effects panned in space | `mix-events.json` beds per scene, `mix-add-<sc>.json` notes |
| S2 | Outside dialogue, beds are no more than 6 dB under music. No shot lacks a bed except the intentional silences: <shot ids> | `audit-mix-buses.py <ep> <sc> --allow <ids>` |
| S3 | The space is audible: inside or outside, weather, room size. A cut from inside to outside sounds different, and so does a wide shot from a close-up | listen; Gemini as a pointer only |
| S4 | Spot effects match the picture (fire crackles, flybys, sirens); no wrong material, stray voices or music in a bed, or clicks at loop joins | listen with the frame at that time |
| S5 | Foley follows large motion (runs, falls, footsteps, doors, keys, servos) | listen with the frame |
| S6 | Dialogue is clear over the bed: vo minus beds is +6 dB or more on every line | audit `vo-b` column, listen |
| S7 | -14 ±1 LUFS and at or under -1.5 dBTP on every delivered file | `renders/deliveries.jsonl` |
| S8 | No technical faults: chopped sounds, pops, dropouts, audio out of sync | `qa-prescan.py audio` and `events` |

### Picture

| # | Criterion | How to check |
|---|---|---|
| V1 | No exposed frame edge (shake, camera slam, rig) | `qa-prescan.py picture`, zoomed crops at flagged frames |
| V2 | Overlays ride their plate (no layer-split parallax, no HUD floating off a moving shot) | strips across each move |
| V3 | Characters are on model and present once (no duplicates, no extra people); hands belong to the right person | contact sheets at full size |
| V3b | Blocking follows the script: who is in frame, who enters from where, whose hands are on what; set geometry continues from the previous shot (a curved wall stays curved, stairs keep their direction) | script excerpt beside each strip |
| V3c | Props and decals the script says already exist are present on every shot from their first appearance | continuity.json `shots`, zoomed crops |
| V3d | No still holds longer than 1.5 s without motion; actions read at real speed | `qa-prescan.py picture` static holds |
| V4 | Staging and physics: ground contact, perspective, grip logic, 180-degree rule | strips at action beats |
| V5 | Captions start on the first word and end with the cut; text is legible at phone size | frames at each line start and end |
| V6 | Transitions are motivated where a hard cut jars; music ends on a phrase | watch each cut |

### Regression

- Picture and dialogue are locked from <previous cut>. Compared with `renders/<sc>-<prev>-master-720p.mp4`,
  nothing changes except the items above.
- Scene lengths are unchanged: <scNN NN.NNN s, ...>.
- No real brand text is visible.

## C. Output of each agent

Agents work independently: B never reads A's report.

Write `plans/<plan>/reports/qa-<a|b>-<date>-<cut>-r<N>-<sc>.md`, with a PASS / PASS-TRIM / FAIL table for
every item (sound items per scene) and evidence in each cell, plus the same verdicts as JSON next to it:

```json
{"round": 1, "agent": "A", "render": {"file": "renders/sc03-cut3-r4-master-720p.mp4", "verdict": "FAIL", "score": 6,
  "items": [{"rubric": "A1", "verdict": "FAIL", "t": "56.667-57.417", "desc": "s13 hit 18 frames after the plate"}],
  "issues": [{"severity": "cao", "t": "56.667", "frames": "1360-1378", "desc": "...", "fix": "..."}]}}
```

Severity is `cao` (high), `vừa` (medium) or `thấp` (low). The render passes only when both agents pass every
item, both score 7 or more, and no issue is `cao` or `vừa`: run `scripts/qa-gate-check.py` on the two JSON
files. Reply in about 10 lines with the report paths, ending with a `Status:` line.
