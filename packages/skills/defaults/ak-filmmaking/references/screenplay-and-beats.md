# Screenplay and beats

Never jump from a prose idea to video prompts. The script layers decide what
the film is before any credits are spent.

## Screenplay (`screenplay.md`)

- Standard screenplay form: scene heading, action, character cue, parenthetical,
  dialogue. Each scene heading carries its scene ID (`## S02 - INT. CAFE - DUSK`).
- Write dialogue to be spoken, then read it aloud at performance pace. Spoken
  length drives duration: roughly 2.5-3 words per second for natural speech,
  slower for emotional beats. Long monologues become coverage problems later.
- Put performance intent in parentheticals sparingly; they become voice
  direction and the `emotion` field of shots.
- Mark deliberate silences. A held pause is a timing decision the dialogue
  master and animatic must preserve.

## Beat sheet (`beat-sheet.json`)

Each beat records the narrative purpose, the dramatic question it raises or
answers, the emotional state, the change (reveal or turn) it delivers, the
sound intent and an optional music theme ID. Every scene belongs to at least
one beat; `validate` warns when a scene has no recorded purpose, because a
scene without a purpose is the first cut candidate in the animatic.

Beats also seed the music cue sheet: `music_theme` names a motif such as
`THEME_A_TENSION` that later becomes an MX cue with the same theme ID.

## Length planning

Estimate scene lengths from the script before breakdown: dialogue time plus
action time plus deliberate pauses. Compare the sum with
`target_duration_minutes`; a 12-minute target with 20 minutes of dialogue needs
a rewrite, not faster cutting.

## Review gate

Before breakdown, confirm with the user: logline, ending, character arcs, scene
list and any line they care about. Script changes after storyboarding cost
storyboard frames; after rendering they cost generations.
