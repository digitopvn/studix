# Knowledge packs and FilmSpec

Craft knowledge that is too long for `SKILL.md` lives in small packs. An agent loads only the pack, or the
section of a pack, that its task needs. FilmSpec is the optional machine-readable contract for story and
shots. Both are opt-in: nothing reads them unless `knowledge` or `filmspec` is run.

Code: `scripts/studio/knowledge_packs_and_film_spec.py`. Packs: `knowledge/index.json` and
`knowledge/packs/<id>.json`.

## Packs

```bash
python3 scripts/anime-studio.py knowledge list
python3 scripts/anime-studio.py knowledge for camera lens keyframe
python3 scripts/anime-studio.py knowledge show dop-camera --section checks
python3 scripts/anime-studio.py knowledge lint
```

| Pack | Covers |
|---|---|
| `narrative` | causality, want and stakes, setup and payoff, twists and easter eggs, arcs |
| `performance` | surface and hidden emotion, micro-behaviour, gaze, pauses, voice intention |
| `art-direction` | a registry of eight looks, each with tokens, palette, risk, camera fit, cost, licence and when not to use it |
| `dop-camera` | visual intent, size, lens, height, motivated moves, the 180-degree line, light ratio |
| `wardrobe-props` | wardrobe states driven by events, materials, props, set dressing, source labels |
| `physics-lite` | weight, contact, fire, water, smoke and light responses, and justified stylised exceptions |
| `sound` | room tone, material-aware Foley, motifs, J and L cuts, silence |

Each pack holds the following:

- its purpose and use cases;
- anti-patterns;
- the tool roles allowed to use it;
- checks;
- the FilmSpec fields it relies on;
- references to the skill's own reference files.

`lint` fails when one of these is missing, when a check is malformed or its id repeats another (base checks
included), or when a hard check names neither a computed function nor a gate command. A gate command exits 1
when its check fails: `validate`, `validate-action`, `continuity` and `assets check`. A command that only prints
a measurement, such as `loudness` or `status`, backs an evidence check (its `tool`).

Looks are described by visual traits. A prompt never names a living artist or a studio.

## Check kinds

Kinds are never averaged into one score: a failing hard check is not offset by good reviews.

| Kind | Who decides | Example |
|---|---|---|
| `hard` | a deterministic function on `filmspec.json`, or a gate command (`validate`, `validate-action`, `continuity`, `assets check`) | a camera move with no motivation |
| `evidence` | a reviewer, with frames, timestamps or measurements | the scene's change still reads with the sound muted |
| `human` | the user | the episode is signed off |

## FilmSpec

```bash
python3 scripts/anime-studio.py filmspec $EP --init                # skeleton from episode.json and the EDLs; never overwrites
python3 scripts/anime-studio.py filmspec $EP [--json]              # validate, then run the computed hard checks
python3 scripts/anime-studio.py filmspec $EP --checklist shot      # the DoD for one level: base plus the applied packs
```

`episodes/<ep>/filmspec.json` has these fields:

- `packs`: the packs that apply.
- `look.style`: an art-direction registry id.
- `logline` and `arc`.
- `setups` and `payoffs`. These are the twist ledger. They are kept out of `story/continuity.json`, which
  stays the physical state that keyframe prompts read. A setup paid off in a later episode sets
  `payoff_later`.
- `scenes`: each scene has `want`, `stakes`, `change`, `room_tone`, `motif` and `shots`. Each shot has
  `intent`, `camera` {`size`, `lens_mm` (full-frame equivalent) or `fov`, `height`, `move`, `motivation`}, `blocking`,
  `performance` {`surface`, `hidden`}, `wardrobe` {character: {`look`, `event`}}, `physics`
  [{`what`, `exception`, `reason`}] and `sound` {`cut`: J, L or straight, for the cut into the shot}.

Field types are checked first, so a wrong shape is reported as an error rather than a crash. Scene and shot ids
are checked against `episode.json` and the EDLs, and a mismatch is a warning. Setups and payoffs are ordered by
`episode.json`, so re-ordering the cut without touching the spec still catches a payoff that now comes first.
Ids must be strings, and setup ids must be unique. A missing or unreadable `episode.json` is reported, and
the scene order then falls back to the spec. `--checklist` names any pack the spec lists that is not
installed and exits 1.
The command exits 1 on an error or on a failing hard check.

## Definition of done per level

`--checklist` combines the base DoD with the checks of the packs the spec applies:

| Level | Base checks |
|---|---|
| asset | integrity, references resolve (hard); provenance and the licence of imported material (evidence) |
| shot | EDL valid, join contract, continuity (hard); two-reviewer technical QA, intent reads (evidence) |
| scene | `change` recorded (hard); silent-story pass (evidence); the user's sign-off (human) |
| episode | loudness, deliverables and the consistency contact sheet (evidence); the user's sign-off (human) |

Recording a `PASS`, `FAIL` or `WAIVED` result with its evidence and approver is the observability
workstream's part. Until then the checklist is the contract, and the existing gates G0-G4 stay
authoritative.

## Measured

Measured on 2026-10-27. Frontier was only read; the ep01 test ran on a copy of its `episode.json` and
scene EDLs.

- **Context:** the skill's references total 142 KB, and `keyframes-and-ai-video.md` alone is 19.7 KB.
  One pack renders at 1.9 to 5.4 KB, and the camera checks alone are 0.7 KB.
- **ep01 skeleton:** `filmspec --init` gives 6 scenes and 159 shots, which shows how much creative intent
  is not written down today. With every pack applied, 4 of 10 computed hard checks fail:
  - 159 shots have no lens;
  - 6 scenes have no `change`;
  - 6 scenes have no room tone;
  - the look is not set.
