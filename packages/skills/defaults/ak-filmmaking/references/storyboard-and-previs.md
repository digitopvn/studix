# Storyboard and previs

Do not burn video credits to discover framing.

```text
shot spec -> storyboard still -> continuity review -> approved still/keyframe -> video generation
```

## Storyboard stills

- One still per shot at `storyboard/<shot_id>.png`, recorded in the shot's
  `storyboard` with status `draft`, `approved` or `rejected`.
- Generate them with the installed image-generation skill, conditioned on the
  shot's canonical character, wardrobe, location and prop references. Cheap,
  fast image models are fine for boards; identity must still read correctly.
- Board composition reasoning (framing, staging, eyelines) can borrow the
  storyboard concepts of `ak-video`; this skill adds the graph, continuity and
  approval gates on top rather than a second storyboard format.

## Review questions per board

- Does the composition tell this beat of the story?
- Is the character identity correct against the canonical pack?
- Is the wardrobe the scene's state? Are props in the right hand and position?
- Does the screen side and direction cut against the adjacent boards?
- Is the shot needed, or does the animatic play without it?

Fix the graph (and rerun `validate`) before fixing the picture.

## Keyframes

STANDARD, CHARACTER_CRITICAL and HERO shots need an approved `keyframe` before
video generation: a production-quality still that becomes the start frame when
the provider supports one (`start_frame` capability). CHEAP_BROLL and PREVIS
shots can generate from the approved storyboard alone.

A keyframe that drifts from identity is a candidate image, not a new reference.
Regenerate it from the canonical pack instead of promoting it.

## Previs

Use `render_class: PREVIS` for throwaway motion tests (blocking, camera move
timing). They skip identity anchoring and should run on the cheapest available
model; their outputs never become canonical references.
