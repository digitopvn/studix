# Scriptwriting and Performance Guide

Use this when writing (`script`), enhancing (`enhance`), or directing
multi-speaker (`dialogue`) text for ElevenLabs. The agent is the writer and
voice director; the model is the performer. Synthesis details live in
`references/text-to-speech-guide.md`.

## Contents

- Mode rules: script, enhance, dialogue
- Writing for the ear
- Performance beats
- Audio-tag strategy
- Punctuation as performance control
- Hesitation, breath, laughter, whispering, comedy timing
- Narration vs dialogue; multilingual scripts
- Voice-readability pass and output contract
- Examples

## Mode Rules

### `script`: idea or rough copy -> performance-ready script

1. Resolve intent: narration, commercial, storytelling, comedy, character
   performance, explainer, dialogue, or expressive demo. Also resolve target
   language, length/duration, audience, voice character, and target model.
2. Write for speech (see "Writing for the Ear").
3. Plan beats: opening state, transitions, emphasis, pauses, reactions, ending.
4. Add directions the target model supports (audio tags for v4/v3; punctuation
   and, where supported, `<break>` for v2/Flash).
5. Tune punctuation and line structure for timing.
6. Run the voice-readability pass.
7. Synthesize only when the user wants audio and the script passes the pass.

### `enhance`: keep the words, improve the performance

- Preserve every spoken word, its order, and its meaning. Do not add, remove,
  or reword dialogue or narration; never put original text inside brackets.
- Add only audio tags that change the delivery of that line; leave neutral
  lines untagged. No tag on every line.
- You may adjust punctuation, capitalization for emphasis, ellipses, and
  question/exclamation marks.
- Do not turn existing narrative into tags ("He laughed" stays; you may add
  `[chuckles]` after it). Do not invent lines or turn visual actions into tags.
- Tags must not contradict the line's intent.
- Output only the enhanced spoken script unless analysis was requested.
- Self-check: strip all `[...]` tags and compare to the input; any word-level
  difference other than punctuation/capitalization is a failure to fix.

### `dialogue`: multi-speaker direction

- Give each speaker a distinct voice (and confirm the voice IDs) and a short
  character note in production notes: age, energy, attitude, pace.
- Write one turn per line with a speaker label; put per-turn tags inside the
  turn text. The label is metadata, not spoken text.
- Shape turn-taking: interruptions with a trailing dash on the cut line and a
  leading dash or `[jumping in]` on the next; overlaps with `[overlapping]`;
  hesitations with ellipses.
- Vary delivery between characters so they do not converge on one tone.
- For synthesis on v4/v3, map turns to Text to Dialogue `inputs` (text +
  voice_id per turn); split scenes that exceed the documented per-request size.

## Writing for the Ear

- One idea per sentence; mostly short sentences, with a longer one for rhythm.
- Spoken phrasing and contractions natural to the target language and register.
- Front-load the subject; avoid nested clauses, parentheses, and footnote logic.
- Repeat key nouns instead of ambiguous pronouns; listeners cannot re-read.
- Expand anything read ambiguously aloud: numbers, dates, currencies, units,
  abbreviations, URLs, symbols, acronyms ("A-P-I" vs "appy").
- Remove visual-only references ("see below", tables, bullets read as fragments).
- Put intentional pauses where a listener needs to absorb a point.

## Performance Beats

Mark the emotional path before tagging:

| Beat | Question to answer |
|------|--------------------|
| Opening state | How does the speaker feel on the first word? |
| Turn(s) | Where does the feeling change, and why? |
| Emphasis | Which one or two words per sentence carry the meaning? |
| Pauses | Where does the listener need a beat? |
| Reactions | Where would a real person laugh, sigh, or breathe? |
| Ending state | How should the last line land? |

Transitions should be motivated by the text; an abrupt jump from `[sobbing]` to
`[cheerful]` with no cause sounds broken.

## Audio-Tag Strategy (v4, v4 Turbo, v3)

- Tags are natural-language directions, not a closed list. Choose the words
  that describe the sound you want: `[tired, barely above a whisper]`.
- Place the tag right before the words it colors; a tag holds until the
  delivery is redirected.
- Density: roughly one tag per emotional change, not per sentence.
- Prefer voice-quality wording over sound-cue wording when you mean delivery
  (`[low, gravelly voice]` rather than `[growl]`).
- Tags must be auditory. Visual directions (`[smiles]`, `[looks away]`,
  `[pacing]`) stay in production notes, never in the spoken payload.
- Combine tags sparingly (`[whispers] [nervous]`) and audition the result.
- Experimental tags (accents, singing) are voice-dependent; flag them.
- Models without audio-tag support (Multilingual v2, Flash) may read tags
  aloud or ignore them; direct those with wording and punctuation instead.

## Punctuation as Performance Control

| Mark | Effect |
|------|--------|
| `...` | Hesitation, trailing off, weight before a reveal |
| `—` or `-` | Abrupt cut, interruption, self-correction |
| `,` | Short breath |
| Line or paragraph break | Larger pause, scene shift |
| `CAPITALS` | Emphasis on one word (not whole sentences) |
| `?` / `!` | Intonation lift or energy |

On v4/v3, punctuation and structure replace `<break>` tags. On v2/Flash,
`<break time="x.xs" />` (max 3 s, used sparingly) is available.

## Hesitation, Breath, Laughter, Whispering

- Hesitation: fillers written as spoken ("uh", "I mean"), ellipses, a restart
  with a dash: "I was going to— no. Never mind."
- Breath: `[inhales deeply]`, `[exhales]`, or a paragraph break before a heavy line.
- Laughter: scale it (`[chuckles]`, `[laughs]`, `[laughs harder]`); put it
  where the joke lands, not before.
- Whispering: `[whispers]` before the secret; return to normal with a new
  direction (`[normal voice]`) or a clear scene break.
- Crying or strain: `[voice breaking]`, `[crying]`; keep words intelligible.

## Comedy Timing

- Setup plain, beat, punchline short. A pause (`...` or line break) right
  before the punchline; a reaction tag after it.
- Deadpan works with no tag at all; `[deadpan]` only if the voice drifts upbeat.
- Do not tag the punchline as `[funny]`; tag the delivery (`[dry]`, `[mock-serious]`).

## Narration vs Dialogue

- Narration: steadier stability, fewer tags, direction at scene or paragraph
  level (`[quiet, reflective narration]`), pacing by paragraph structure.
- Dialogue: per-turn tags, interruptions, distinct voices, lower stability for
  livelier exchanges. Keep narrator lines and character lines on separate turns.

## Multilingual Scripts

- Write natively in the target language; do not translate English tags into
  odd literal phrases inside the text. English tag words are acceptable.
- Apply that language's number, date, and honorific conventions.
- Pass `language_code` on models that accept it; check that the chosen model
  lists the language.
- Note pronunciation risks (names, loanwords) in production notes; use IPA in
  slashes on v4 or phonetic spelling elsewhere.

## Voice-Readability Pass

Before delivery or synthesis, confirm:

- [ ] Reads naturally aloud at the intended pace; no dense written prose.
- [ ] Numbers, symbols, abbreviations are speakable.
- [ ] Tags are auditory, motivated, and not on every line.
- [ ] Transitions between emotional states are plausible.
- [ ] Pauses use markup the target model supports (no `<break>` on v4/v3).
- [ ] No visual stage directions inside the spoken text.
- [ ] Each chunk fits the target model's request size; long-form chunks split at
      natural boundaries with stitching context planned.
- [ ] For `enhance`: tag-stripped text matches the input wording.

## Output Contract

For `script` and `dialogue`, return two layers when useful:

1. **Performance script**: the exact text to send, including tags and
   performance punctuation, nothing else.
2. **Production notes** (never spoken): recommended model, voice
   characteristics or IDs, risky/experimental tags, pronunciation notes,
   chunking plan, and lines likely to need auditioning or regeneration.

For `enhance`, return only the enhanced script unless analysis is requested.

## Examples

### Narration (v4)

Raw copy:
> Our solar program reduced energy costs by 32% in 2024 for 1,200 households across 3 provinces.

Performance script:
```text
[warm, steady narration] In twenty twenty-four, something changed for twelve hundred families.

Across three provinces... their energy bills dropped by thirty-two percent.

[quietly proud] Not a forecast. Not a promise. Real savings, on real kitchen tables.
```

Production notes: `eleven_v4`, calm mid-range narrator, stability ~0.6; numbers
expanded; audition the second line's pause.

### Emotional Monologue (v4)

Raw copy:
> I found your letter. I was angry at first, but I understand now and I forgive you.

Performance script:
```text
[quietly] I found your letter.

[voice tightening] I read it... three times. And the first time? [bitter laugh] I was SO angry.

[exhales] But then I kept reading.

[softening, voice breaking] And I understand now. I do.

[gently] I forgive you.
```

Production notes: arc is numb -> anger -> release -> warmth; stability ~0.35;
`[bitter laugh]` is voice-dependent, audition it.

### Multi-Speaker Dialogue (v4, Text to Dialogue)

```text
MAYA: [breathless] Okay, okay— you will NOT believe who just walked in.
LEO: [distracted, flat] If you say "the landlord," I'm hiding.
MAYA: [whispers] It's worse.
LEO: [slowly] ...Worse than the landlord?
MAYA: [jumping in] Your mom. With a casserole.
LEO: [long exhale] [defeated] I'll get the plates.
```

Production notes: MAYA = bright, fast, mid-20s voice; LEO = dry, low-energy
voice; send each line as one `inputs` turn with that speaker's `voice_id`;
speaker labels are not spoken.

### Enhance (wording preserved)

Input:
> Are you serious? I can't believe you did that! I guess it's fine. It's just... a lot.

Enhanced:
```text
[appalled] Are you serious? I can't believe you did that! [sighs] I guess it's fine. It's just... [muttering] a LOT.
```

Removing the tags gives the original sentence; only capitalization changed.
