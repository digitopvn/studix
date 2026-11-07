# Series bible, character consistency and story context

A long series stays consistent because every prompt, voice and staging choice is read from files, not
recalled. The same files make a fresh agent (after compaction, or a subagent) productive without re-reading
the whole history.

## Project layout

`anime-studio.py init-series <slug>` (or `init-clip` for a one-off) creates it under `$ANIME_STUDIO_ROOT`:

```text
<series>/studio.json                  title, fps, aspect, languages
<series>/bible/series-bible.md        world, tone, cast relationships, visual language, sound palette, arc table
<series>/bible/style.json             prompt block, video block, negatives, grade look, fps, caption font
<series>/bible/characters/<id>.json   one per character (template: character.example.json)
<series>/bible/sets/<id>.json         one per location (template: set.example.json)
<series>/bible/refs/                  model sheets, set establishing frames, layer decompositions
<series>/story/story-so-far.md        rolling digest, under 2,000 words
<series>/story/continuity.json        state at the end of the latest episode
<series>/engine/                      shared film engine, built once per series
<series>/episodes/epNN/               episode.json, scope-lock.md, gen-plan.json, scenes/, gen/, logs/, reports/
<series>/runs.jsonl                   one summary row per finished run
```

## Character file

Fields that earned their place:

- `anchors` (5): the details a viewer checks first, written as visible facts ("ash-pink hair in a high
  ponytail with two peach-blossom pins"). Every keyframe prompt carries all five.
- `handedness`: written as a sentence the prompt can quote ("her sword is always in her RIGHT hand"). A grip
  that contradicts the strike direction was a user-caught defect.
- `silhouette`, `props`, `palette`: what must survive at thumbnail size. Keep `props` to what the character
  carries in every scene; a habit prop ("always holds a noodle cup", "checks his phone") written into the
  character text was drawn into nearly every shot, by the keyframe model and by local H3 alike. Put such a
  prop in the shots that use it (staging record below).
- `scale`: height against a reference figure ("1.5x an adult man", "palm-sized"); non-human and robot
  characters drifted in size between shots without it.
- `age`: a visible-fact sentence ("about twelve, round face, no stubble"); a child read older in later
  boards when the anchors only covered hair and clothes.
- `sheet`: path of the model sheet (front, three-quarter, back on one image, plus expressions if the
  character acts). Generated first, approved at G1, passed as reference to every later image.
- `voice`: provider, `model` (for example `gemini-3.8-flash-tts`), `voice_id`, language, `accent` (the gate
  for every take: "Southern, Saigon"), `respellings` (names the model mispronounces, applied before
  synthesis), delivery notes; TTS seed once a take is approved.
- `acting`: how this character moves and emotes (restraint, tells, tempo).
- `negatives`: drift seen in earlier runs ("no brown haori").

## Set file

`description`, `light` (direction, time of day), `ground` (what feet stand on and its row in the plate),
`camera` (the staging rule, e.g. "low-angle and three-quarter views with real perspective; never a flat
side-on stage"), `layers` (layer-decomposition output), `weather` preset, `refs`.

## Staging record (blocking that must not flip)

Most storyboard notes on FRONTIER ep03 (28 in the first round, 11 in the second; two fixes failed twice) were
staging facts that changed between panels, not drawing quality. Write them down once per scene, before the
first board, in `scenes/<sc>/staging.md`, and compile each shot's prompt from it:

- **Seat map** for every vehicle and fixed position: who sits front or back, left or right, who drives, who is
  at the console. Give sides as the character's own left or right, and convert to frame left or right per
  camera side in the shot brief; the reverse angle mirrors frame sides and swapped riders twice.
- **Vehicles and big props** as a sheet like a character: model, roof or no roof, doors, colour, damage
  state. A car lost its roof between panels.
- **Direction of travel and slope**: which way the convoy drives in frame, whether the ramp goes up or down,
  where the exit is. Keep screen direction across cuts unless a shot crosses the line on purpose.
- **Scale chart** of the cast in the scene, from each character's `scale`.
- **Prop scope per shot**: the props visible in this shot and in whose hand; every other shot says "empty
  hands" for that character. Weapons get their grip and length (a blade held by the handle, edge out).
- **Landmarks** of the set that the story uses (the gate, a socket, a console) with their position, so the
  same object is drawn in the same place.
- **Time of day** as one sentence per scene, repeated in every shot prompt.
- **Carry-over from the previous episode**: where each character was in the last shot of epNN-1
  (`continuity.json` `state`); an opening that ignored it drew a character away from her console.

A board that is right except for the side can be mirrored instead of redrawn; check text, handedness and
insignia after the flip.

## Prompts come from the bible

`anime-studio.py prompt <episode> <job>` compiles a job's prompt from the character, set and style files plus
the job's own action text, and selects up to three references (`--max-refs`). More references made results
less faithful, not more (brown haori, wrong pose, framing too wide). For a retake, tighten the action text
and drop a reference rather than adding one.

## Long storylines: what to keep in context

| File | Updated | Read by |
|---|---|---|
| series-bible.md | when the user changes the world or cast | G0 of every episode |
| story-so-far.md | at the end of each episode: append 100-200 words, compress older parts to keep it under 2,000 words | every episode's interview and scope |
| continuity.json `state` | at episode end: per character location, injuries, costume changes, props held, relationships, secrets known | prompt writing, staging, dialogue |
| continuity.json `open_threads` | when a setup is planted or paid off | beat sheet of later episodes |
| episode.json | every gate and scene change | `status` |

`anime-studio.py context-pack <episode> <scene> <shot>` prints just what one shot needs (its beat, the
neighbouring shots, the characters and set in it, continuity state, the digest). Hand that to a subagent
instead of the bible.

## Continuity checks between shots

- Screen direction: who faces left and right in a scene is fixed by the first wide shot (180-degree rule);
  write it in the scene's beat notes. A drawing briefed "facing left" came back facing right once and was
  caught only with a grid overlay.
- Props across a cut: drawn, sheathed, broken, in which hand. Omni never sheathed a sword it did not see
  sheathed; the end pose needs a last frame.
- Light direction and time of day per set; weather and particle density per shot in `scene-config.js`.
- Costume damage and hair state carry over within an episode and into continuity.json.
- Prop and decal state (paint, a wound, damage the script says already exists) must be on every shot from
  its first appearance. Track it per shot in continuity.json `shots` (keyed `ep01/sc03/s11`);
  `context-pack` prints that state into the shot's brief. Both QA agents rated a chest decal that
  vanished for three shots before its reveal as high severity. A risk a build report lists is fixed or blocks
  the hand-off; it is never just carried into the next cut.

### Before and after state

A shot entry may be structured: `state_before`, `state_after`, `invariants` (`"mira.hand=right"`),
`changes` (keys the shot itself changes) and `overrides` (`{key, reason, reviewer}`). Legacy flat entries
still work and count as both before and after. `anime-studio.py continuity <ep> <scene> [--next sc03/s01 |
--next ep02/sc01/s01] [--series-state] [--json]` walks the scene carrying state forward: a key a shot leaves
out keeps its last value, and a key a shot names is compared with the last value an earlier shot gave it (a
first mention is not a finding). **definite** when both entries are structured and differ, **suspected**
for a legacy text difference, a value only the series state gives, an invariant break (checked against the
carried state too) or a carried key that only `state_after` moves, **allowed** when `changes` or a reviewed
override covers it. It exits 1 on a definite finding. See the `ep01/sc02/s06`
example in `assets/templates/continuity.json`.

`--next` into another episode, or `--series-state` on an episode's last scene, puts the series `state`
block (the state after `after_episode`) after the scene's last shot: the keys this scene's shots name are
checked against it (suspected on a difference), and the next episode's first shot is compared with the last
shot that set each key, so a structured contradiction across episodes is definite and fails the gate even
when the summary is wrong; a key only the series state names is compared with it as suspected. A block whose `after_episode` is empty or another episode adds a suspected
`after_episode` finding: update it after each episode.
On the bench it still caught a planted wrench-to-gun swap as definite, and the four omitted-key findings of
sc02 are gone.

## Voice consistency

One `voice_id` per character for the whole series. When Omni speaks a line natively, its voice changes from
clip to clip; either keep that (it lip-syncs) and accept small timbre drift, or run `voice-changer` to the
bible voice. Record which in the scene notes so later episodes match.

## Surviving compaction and handover

State lives in files: gates in episode.json, every paid job and its status in gen-plan.json, Atlas ids in
`logs/predictions.log`, events in `logs/trace.jsonl`. After a compaction or in a new session, run
`anime-studio.py status <episode>` first; it prints gates, scenes, spend and the last trace events.
