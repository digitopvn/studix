# Scene and shot planning

## Scene breakdown (`scenes/<id>/scene.json`)

A scene owns everything that is constant within it: location, time of day,
weather, lighting, active characters, each character's wardrobe state, props,
dramatic purpose and audio context. Shots inherit those values; `validate`
rejects a shot whose location, cast, wardrobe or props disagree with its scene
unless the change is declared.

## Shot list (`shots/<id>/shot.json`)

Each shot owns framing (`shot_type`, `lens`), `camera` movement, `action`,
`emotion`, `duration_target`, visible `characters`, `props`, canonical
`references`, `visible_speakers`, `lipsync` route, continuity links and state,
`render_class`, `model_requirements`, `retry_budget` and an `estimate`.

Duration heuristics (guidance only; the story decides):

| Shot type | Typical |
|---|---:|
| Establishing | 3-6 s |
| Reaction | 2-4 s |
| Insert / detail | 2-5 s |
| Action | 4-8 s |
| Dialogue close-up | 5-12 s |
| Over-the-shoulder | 5-10 s |
| Walking / tracking | 6-12 s |
| Hero cinematic | 6-15 s |
| One-take | 10-25 s |

## Coverage for dialogue

Plan dialogue scenes as coverage, not as one speaking shot per line:

```text
two-shot (lips unreadable) -> OTS on speaker -> listener reaction -> speaker close-up
-> insert (hands, object) -> cutaway (environment) -> speaker close-up
```

Set `visible_speakers` only for characters whose mouths are readable. Dialogue
from anyone else plays off-screen over the shot. This improves rhythm, hides
imperfect sync, cuts lipsync cost and reduces identity drift. `film.py coverage`
reports visible-lipsync seconds against total dialogue, so the ratio is a
measured number rather than a guess.

Give `duration_target` in whole frames at the project fps; `validate` warns
otherwise (at 23.976 or 29.97 fps, derive seconds from a frame count).

Cutting rules the graph enforces:

- Keep the 180-degree line: a character's left/right side holds across linked
  shots unless a declared change (for example a visible camera cross) explains it.
- A reaction shot keeps the off-screen speaker's state: when that character
  returns, wardrobe, side and condition must match where they were last seen.

## Render class

| Class | Use |
|---|---|
| `PREVIS` | Throwaway framing tests; identity anchoring not required |
| `CHEAP_BROLL` | Environment, inserts, cutaways without faces |
| `STANDARD` | Ordinary character shots |
| `CHARACTER_CRITICAL` | Faces carrying the scene, speaking close-ups |
| `HERO` | The handful of shots the film is remembered by |

Most shots in a well-planned film are CHEAP_BROLL or STANDARD. Set
`retry_budget` per shot; exceeding it is a warning to re-plan the shot rather
than keep rolling.

## Continuity links

Set `continuity_from` / `continuity_to` along the cut, including across scene
boundaries when state carries (wet hair, a carried prop). See
`references/continuity-graph.md`.
