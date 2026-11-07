# Interview, scope lock and review gates

The expensive failure in this pipeline is not a bad render. It is two hours and $4 spent on a film the user
did not picture. Every paid call happens after the user has agreed on the story, the cast and the look.

## Interview (before G0)

Read the brief first, and any script or story files the user already has, in full; then ask only what they
leave open. FRONTIER lost a round pitching three concepts when a full script was already in the folder.
Cache what you read as a compact `work/beats.json` (scene, shot, characters, line ids) and work from that,
not from re-reading a 31k-character script. Group questions; three short rounds at most. Each
question comes with 2-4 concrete options and a recommendation, so the user can answer with one click. If the
user says "em tự đề xuất", pitch 2-3 concepts (logline, look, one signature shot each) and let them pick.

| Round | Settle | Options worth offering |
|---|---|---|
| 1 Story | What happens (beginning, turn, ending image); length; single clip, episode or series; dialogue language and caption language(s); tone | Length 15s / 30s / 60s / episode; dialogue zh, ja, vi, none; captions spoken + translation |
| 2 Look and cast | Style family; characters (count, silhouette, colours, weapon hand); sets; reference titles for feel (timing only, never copied) | ufotable digital composite (default), TV cel, painterly Ghibli-like, chibi comedy |
| 3 Sound, money, mode | VO yes/no and source; music genre; budget ceiling; fps; gated or `--auto` | Ceiling $2-4 per 15s (measured range) or higher for more AI video; 24fps (default) or 48fps on request |

Skip a round when the brief already answers it, and say which answers you assumed. Ask the target runtime
of every episode at G0, even when the series has one; an under-length episode was a user note.

### Expectation management (say it once, plainly, in round 1 or 3)

- Cash: about $0.24 per film second measured (15.7s film = $3.80). Claude tokens cost more than cash:
  about $22.8 API-equivalent for the same film when nothing is reused. Wall clock: about 2 hours per 15s.
- AI video can morph limbs after 4-5s and cannot be seeded into identical motion. Mitigation: short inserts,
  first/last frames, code for everything that does not need AI.
- Native lip-synced speech comes from Omni. For a series voice (TTS), Omni acts the line and the TTS take
  is aligned onto its mouth within 3 frames (`audio-voice-and-mix.md`, "Dialogue on screen"); a shot that
  hides the mouth is the cheaper fallback.
- Text inside generated frames garbles; all titles and captions are DOM overlays.
- Character consistency comes from model sheets and fixed anchors, not from a trained model. Expect one
  retake per 5-8 keyframes.

## Proposals the agent always brings

The user should never have to invent the craft. With each scope draft, propose per beat: shot size, camera
move, the tier (T0-T3) and the "wow" element of that beat (impact frame, eye sparkle, petal vortex, hit-stop,
whip pan, rack focus). Point out the one shot that deserves the expensive tier and why. Offer a cheaper
variant when the estimate is near the ceiling.

## G0 scope lock

Write `episodes/epNN/scope-lock.md` from `assets/templates/scope-lock.md`: logline, length, beat sheet with
tiers, dialogue table, characters, sets, sound, budget (ceiling, estimate from `anime-studio.py budget`,
retake allowance), mode and authority, non-goals, acceptance criteria. Quote the budget as an expected
figure plus a separate contingency: FRONTIER ep03 was quoted $18.80, which was the sum of its contingency lines,
and the real spend landed near $20-21 once routes outside the ledger were counted. Show it, wait for a clear yes, then
`anime-studio.py gate <ep> G0 approved --note "<what the user said>"`.

## Gates

| Gate | Shows the user | Stops even with `--auto` | Cost before it |
|---|---|---|---|
| G0-scope | scope-lock.md, beat sheet, estimate | yes | $0 |
| G1-designs | model sheets, set establishing frame, style frame, voice samples if TTS | yes | ~$0.10-0.45 |
| G2-animatic | keyframes (and 360p previz) cut to timing with temp captions | no | + keyframes, previz |
| G3-rough-cut | conformed video + GL + edit render + temp mix | no | + video, upscale |
| G4-final | graded master, preview, process report | no | all |

### Storyboard round (before keyframes on an episode)

An episode gets a board per shot before any keyframe or video job, sent as one contact sheet per scene with
shot ids burned in. Fill the scene's staging record first (`series-bible-and-continuity.md`) and check every
panel against it before sending: seats and sides, vehicle model, direction of travel and slope, scale,
prop scope, landmarks, time of day, carry-over from the last episode. FRONTIER ep03's first board drew 28
notes, almost all of them staging facts; a fix that changed the prompt but not the record failed again. Each
note becomes a line in the record, and the next board is checked against the whole record, not only the
noted panels. The board approval is logged as part of G2 (`gate <ep> G2 ... --note "storyboard"`).

Gate statuses: `approved`, `changes`, `rejected` (and `pending`). Record every outcome with `gate`, so the
report and `insights` can count rejections.

### What `--auto` changes

Under `--auto` the agent approves G2-G4 itself after its own QA checklist passes, and logs each approval as a
`decision` trace event. It still stops and asks when:

- the projected spend crosses the ceiling, or a single unplanned purchase exceeds 20% of it;
- a change would alter the locked scope (new character, cut beat, different ending, language change);
- the same shot fails QA after two paid retakes;
- a model or provider the plan did not name becomes necessary;
- anything touches IP, real people or the user's accounts.

## Handling feedback

- Translate each note into a defect with a frame range and a tag (see the tag list in
  `report-and-telemetry.md`), trace it as `qa_finding` with `--detail "user: ..."`, then fix the cause class,
  not only the frame. "Cánh tay bị cắt ở f56-f66" led to a border-alpha check on every cut-out and found three
  more cut-offs the user had not reported.
- Feedback that changes scope goes back through G0: update scope-lock.md and the estimate, ask again.
- Never silently reverse a locked decision (length, fps, language, budget). Present the trade-off.
- Taste notes ("chưa đủ wow", "như game 2D thời xưa") map to concrete levers: micro-acting (pupils, mouth,
  hair locks, breathing), real perspective with camera moves, impact frames and hit-stop, particle reaction
  to action. Propose two or three of them with costs rather than guessing one.
- **Notes the first cut of an episode drew** (FRONTIER ep03 cut 1, 28 notes), worth planning for before the
  user has to say them:
  - Peak lines read flat: shouts, anger and a stammer need their own direction and takes
    (`voice-takes-and-stylized-voices.md`).
  - Reactions without a sound: a surprised "What?!", inner monologue, a laugh, a sigh, a line said in
    unison. Write them into the dialogue table even when the script only implies them.
  - On-screen state changes without SFX: lights popping, power going down, a collapse, debris, magic. Every
    visible change of state gets a cue.
  - Entrances and climaxes without a music cue.
  - Story transitions rushed while the action rhythm sat inside the reference band: the action band is for
    fights only; story beats need a setup and a reaction shot.
  - A comedic beat needs a sting; a location jump needs a card ("Meanwhile...") or an establishing shot.
- **Rubric.** Paste each round of feedback verbatim into the next cut's QA rubric
  (`assets/templates/qa-rubric.md`), with one item per timestamped note. Two QA agents score against it before
  the user sees the cut. A note the agent paraphrased into something easier was a note the cut failed again.
- **Repeated notes.** A note that comes back after a fix ("SFX vẫn chưa đạt": the SFX still are not good
  enough) means the method failed, not the parameters. Ask what would help (a reference clip, a recorded
  library, a tool) before another round of the same approach.

## Episode delivery habits (FRONTIER)

- **Length.** An episode runs at least 5 minutes with the full script detail. Do not compress beats to fit a
  budget; say what the length costs.
- **Resolution.** Review at 720p and upscale or finish at 1080p only after the user approves the cut.
- **Send as you go.** Send each deliverable (a clip, a sheet, a scene) as soon as it exists, with its path
  and size. Answer "send me the latest link" from `renders/deliveries.jsonl`.
- **Phone copy.** Anything sent to chat stays under 30 MiB; that is the 540p phone copy.

## Originality

Characters, designs and music are original. Reference films may be studied for timing (frame counts,
holds, impact frames) through contact sheets; their frames, characters and music are not inputs to any
generator. No real-person likeness.
