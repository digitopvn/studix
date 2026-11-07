# QA prompts (Gemini `multix gemini analyze`)

One `## <name>` section per prompt; the runner sends the fenced block. Gen-plan qa jobs pick one with
`"qa": "<name>"` and fill `{{BRIEF}}` and `{{LINES}}`. `ai-shot-qa.py` sends `shot-sound` per shot group and fills `{{EP_T}}`,
`{{SCENE}}`, `{{SHOTS}}` and `{{LINES}}`; any multimodal judge in the `ai-judge` role of engines.json can take it. Gemini samples video at about 1 fps and has claimed
lip-sync errors that measurement disproved: treat every finding as a lead to verify with a contact sheet,
`strip` or `lipsync`, never as a verdict.

## keyframe

```text
You are the layout checker for a hand-drawn anime film. Shot brief: {{BRIEF}}
Look at this still and report, concisely:
1) STAGING: is every character standing or landing ON a surface with a believable contact point (feet, shadow,
   occlusion), or do they float? Does the camera have real perspective (horizon, vanishing lines, depth layers)
   or is it a flat side-on stage?
2) CROPS: any head, hand, arm, foot, sword or prop cut by the frame edge or by another object.
3) LOGIC: does each grip, blade direction and pose make physical sense for the action (which hand holds the
   sword, which way the strike travels, where the opponent is)?
4) DESIGN: hair, eyes, outfit, props and marks versus the brief; anything missing or extra.
5) VERDICT: usable / fix (say exactly what to change in the prompt) / regenerate.
No preamble.
```

## clip

```text
You are the QA checker for a hand-drawn anime film. Shot brief: {{BRIEF}} Expected lines: {{LINES}}
Watch this clip frame by frame. Report, concisely:
1) DEFECTS: every visual defect with start-end timestamps (s.ss): face or eye morphing, extra or missing fingers,
   hands merging, sword or blade changing shape or count, hair colour change, outfit change, a second character
   appearing, flicker, smear artifacts that do not read as drawn motion, background warping.
2) ACTING: what the character does, with timestamps.
3) AUDIO: speech transcription with timestamps, other sounds.
4) BEST RANGE: the longest clean continuous range (start-end seconds) with no defect, and a 1-10 quality score
   for that range.
No preamble.
```

## film

```text
You are the QA supervisor for an anime film at Netflix / ufotable quality. Brief: {{BRIEF}} Lines: {{LINES}}
Watch frame by frame and listen. Report concisely:
1) CONTINUITY: any change in a character's face, hair colour, outfit, props or sword between shots, with timestamps.
2) DEFECTS: morphing, extra or merged fingers, warped swords, flicker, compositing errors (particles or glows
   floating wrongly, light effects not on the contact point), floating figures with no motion cue, with start-end
   timestamps.
3) LIP-SYNC: do the spoken lines match mouth movement? Offsets in frames if not.
4) SOUND: do impacts, whooshes, landings and music land on the picture (on the contact frame, not merely on a
   cut)? Does each major hit have weight (a low thump or sub under the crack) and a tail? Anything early,
   late, missing or too loud.
5) STORY: does every beat of the brief read clearly? Which is weakest?
6) SCORE: 1-10 against Netflix/ufotable anime quality, and the three fixes that would raise it most.
No preamble.
```

## shot-sound

```text
You are the re-recording mixer and sound supervisor of an anime episode at Netflix / ufotable quality. Watch AND
listen to this clip. Episode time of the clip start: {{EP_T}}. Scene {{SCENE}}. Shots in the clip (clip-relative
seconds):
{{SHOTS}}
Intended dialogue (in the episode's language, clip-relative):
{{LINES}}
Judge only the SOUND in the context of the picture and the story intent. For each problem give the clip-relative
time, a category and a concrete fix. Categories: missing_sfx (an on-screen or implied event has no sound, or a world
sound the setting needs is absent), sync (a sound early or late against the visible action), voice_character (a voice
that does not fit its character: a robot that sounds human, wrong age or gender, wrong emotion for the moment),
dialogue_clarity (masked, unintelligible or mispronounced words), music_fit (score fights the mood or the dialogue, a
bad entry or exit), mix_balance (something too loud or too quiet), artifact (clicks, cuts, glitches). The clip is cut
from a longer film: a sound that starts or ends exactly at the clip's first or last frame is not a defect. Be strict
but do not invent problems. Return ONLY JSON:
{"score": <0-10 overall sound quality for this clip>, "summary": "<one sentence>",
 "issues": [{"t": <sec>, "category": "...", "severity": "minor|moderate|major", "what": "...", "fix": "..."}]}
```

## action-rhythm

```text
You are the action director and editor of an anime fight at Netflix / ufotable quality. Brief: {{BRIEF}}
Lines: {{LINES}}
Watch frame by frame and listen. For each point give start-end timestamps (s.ss); report only what you see
or hear, and say "none" when a category is clean:
1) IMPACT: every strike or clash. Is there an impact frame (1-4 frames of white, black, inverted or
   silhouette image), a hit-stop, a camera shake? Which strikes have none?
2) TIMING: shots where the action reads slow or floaty (held drawing with nothing moving, an even ease where
   the motion should snap), and shots that cut before the action reads.
3) TRANSITIONS: how each angle change is made (hard cut on action, whip, FX wipe, smash to black, match
   cut). Any that jar?
4) SOUND DESIGN: for each strike, the layers you hear (whoosh before, crack, low thump, debris or ring
   tail), effort breaths or shouts, and where the music drops, ducks or swells. Missing layers?
5) ESCALATION: does the sequence build to one peak, and is the quietest moment just before it?
6) SCORE: 1-10 for the action rhythm alone, and the three changes that would raise it most.
No preamble.
```

Check the answer against `measure-reference-cut.py`: the impact frames, holds and silences it reports are
leads (on eight references, none of five claimed music stops was a stop on the music stem).
