# Grade, master and quality assurance

The user's eye is the final gate, and in three films it caught defects the agent's own review missed:
cut-off arms and blades, illogical grips, floating figures, flat staging. QA here is built so those classes
are caught by measurement before the user sees a frame.

## Grade and master (`anime-studio.py grade`)

```bash
python3 scripts/anime-studio.py grade $EP/renders/sc01-delivery.mp4 --out $EP/renders/ep01 --episode $EP --test
python3 scripts/anime-studio.py grade $EP/renders/sc01-delivery.mp4 --out $EP/renders/ep01 --episode $EP --mix $EP/audio/mix.wav
```

- `--test` renders three graded frames next to the raw ones in seconds. Look at it before the full pass:
  a screen blend in YUV once tinted a whole film magenta, caught only by comparing against the raw frame.
  The graph now converts to planar RGB (`format=gbrp`) before any blend.
- Looks: `warm` (afternoon), `neutral`, `night` (moonlight), `dusk` (orange highs, teal lows), or a raw
  ffmpeg chain. Bloom (default 0.35), grain (default 6), a chroma split on each hit time from the EDL.
- Output: `<out>-master.mp4` (crf 14, grain-tuned, mix muxed) and `<out>-preview.mp4` (two-pass to
  `--preview-mb`, default 25MB, under the 30MB chat transfer cap).
- Masters are 24fps (Netflix and ufotable deliver 23.976). 48fps only when the user asked.
- Run the grade after the render finishes, never alongside it.

### True peak on delivered files

AAC re-encodes overshoot the mix's true peak. Measured on FRONTIER:

- A -2.0 dBFS mix came out at -0.7 dBTP at 720p and 256k.
- A 96k phone copy reached +0.4 dBTP.
- Re-encoding a master's AAC overshot twice.

The rule that fixed it is in `scripts/studio/delivery_encodes.py`, which `finish-scenes.py` and
`assemble-episode.py` use:

- Encode each delivered audio stream once, from the PCM mix, through
  `lowpass=f=18000:p=2,aresample=192000,alimiter=limit=0.8:attack=1:release=50:level=false,aresample=48000`.
  The lowpass is there because one transient in EP03's 330 s join overshot 2.1 dB through the 256k encoder;
  lowering the limit from 0.8 to 0.7 moved it only from -0.9 to -1.0 dBTP, and the lowpass took it to -2.0.
- Use limit 0.6 for 128k phone copies; 0.75 still glitched.
- Joined episode mixes are limited hard already; if a master still measures over the ceiling, pass
  `assemble-episode.py --limit 0.7` (EP03 cut2 needed it) rather than turning the scene mixes down.
- A copy that keeps the picture size takes the audio with `-c:a copy`.
- Measure every delivered file with `ffmpeg -af ebur128=peak=true`: -14 ±1 LUFS, at or under -1.5 dBTP, and
  the 30 MiB limit for anything sent to chat. Each result goes into `renders/deliveries.jsonl`.
- A file that was not measured is not delivered.

A one-off mix outside `build-audio-mix.py` (a lab test, a single shot): never put a single-pass `loudnorm`
inside the `amix` graph. It cut the VO bus short and the mix came out 1.5 s shorter than the picture.
Normalize each VO take to a file first (-18 LUFS), mix the buses, measure the premix, then master with a
linear gain of `target - measured` dB and an `alimiter`; check the duration against the video.

## Three layers of QA

### 1. Measurements (deterministic, run every time)

| Check | Command | Catches |
|---|---|---|
| EDL integrity | `validate` | gaps, off-frame cuts, captions outside shots, missing clips |
| Cut-off figures | `edge <cutouts...>`, chroma-key JSON `edge_touch` | arms, blades, hair touching the image border |
| Frame counts | `conform` report, ffprobe after upscale | dropped or held frames, short sources |
| Action beats | `strip <video> <out> t0 t1 --n 8` | grip vs strike direction, contact point, limb morph, FX position |
| Whole film | `sheet <video> <out> --step 0.5` | continuity, colour jumps, title placement |
| Action rhythm vs a reference | `measure-reference-cut.py <ref> <ours>@t0-t1 --sheet DIR` | slow cutting, few impact frames, long holds, hits off the contact, a thin low end |
| Loudness | `loudness` | LUFS and true peak off target |
| Voice timing | `onsets`, `lipsync --crop` | late or early lines, lip lag |

Read sheets at a size where hands and blade tips are visible; 480px tiles missed two edge crops that full
resolution showed. Make 1000px jpg previews of large frames before reading them (images over ~2MB are
refused by the context firewall).

Prescan before any agent looks: `qa-prescan.py` runs in seconds and finds what agents hunt for slowly. It
found the sc02 f905 wedge in 5 s on a 70 s scene; a QA agent had found it by eye after two renders.

```bash
uv run -q --with numpy python -X utf8 scripts/qa-prescan.py picture renders/sc0*-cut3-r1-master-720p.mp4
uv run -q --with numpy python -X utf8 scripts/qa-prescan.py audio audio/mix-sc0*.wav
uv run -q --with numpy python -X utf8 scripts/qa-prescan.py events <ep> --scenes sc03
uv run -q --with numpy python -X utf8 scripts/qa-prescan.py clips <ep>/scenes/sc05
uv run -q --with numpy python -X utf8 scripts/audit-mix-buses.py <ep> sc01 sc02 sc03
```

What each mode checks:

- **picture:** exposed transform wedges at the frame edge, a leading black run (a stacked fade), black runs
  to look at, and static holds: picture that barely changes for more than `--max-hold` seconds (default 1.5;
  rain or grain over a held cel measured 3-5 on the block-difference scale, any real move 7-60). A held cel
  is what the user rejects as "too static".
- **clips:** cuts inside the source range each shot uses (`in` to `in + length * speed`). Omni hides cuts in
  its clips; never let a used range span one.
- **audio:** clicks, and dropouts inside the file.
- **events:** chopped SFX (cut short with a fade under 80 ms), missing files, bus names outside the four
  buses, hits too quiet to hear, and late transients: a hit whose attack sits more than 2 frames into the file
  with no `onset` key, or whose measured attack differs from its `onset` key.
- **audit-mix-buses.py:** the bed and masking gate.

Hand the agents the output and spend their turns on taste.

### 2. Model review (hints, never verdicts)

`assets/templates/qa-prompts.md` holds the `keyframe`, `clip`, `film` and `action-rhythm` prompts for
`multix gemini analyze` (one file per call; with three files only the first was analysed). `action-rhythm`
asks for impact, timing, transitions, sound layers and escalation per strike; at 1 fps the model cannot see a
1-4 frame impact frame, so take its counts from `measure-reference-cut.py` and its descriptions as leads. Gemini samples video at about
1fps and reads stylised text poorly. In measured runs it claimed bad lip-sync (measured in sync), "missing
impact frames" (present, 2 frames long), "morphing hands" (a whip pan) and misread a technique name. Treat
each claim as a pointer: open a strip at that time or measure, then accept or reject it in the trace
(`qa_finding` with `--detail "gemini: ... -> rejected: strip shows ..."`).

For sound in context, `ai-shot-qa.py` sends short shot groups (whole shots, 9 s or less) of the assembled
episode to the `ai-judge` role with each shot's beat and lines and the `shot-sound` rubric, in parallel, and
sorts the findings by episode time. The same rule holds: each finding is a lead to verify by ear, and the
verdict goes in the trace. Any multimodal model that returns the rubric's JSON can be the judge
(`assets/templates/engines.json`).

### 3. Two-agent rubric gate (before anything goes to the user)

FRONTIER cut 1 shipped after a single QA pass that rejected every Gemini flag. The user judged it far below
the bar. Since then, each cut and each production batch (keyframes, clips) goes to two independent QA
agents, and the cut ships only when both pass every item.

- **Rubric.** Build it from `assets/templates/qa-rubric.md`. It holds the user's feedback verbatim (the
  general points and every timestamped note), then the checklist below, then the regression items from the
  previous cut.
- **Inputs.** Give each agent the rubric, the prescan output, contact sheets, zoomed crops and audio stats,
  so they spend their turns judging, not measuring.
- **Verdicts.** Each item gets PASS, PASS-TRIM (passes after a stated trim) or FAIL, with frame or timestamp
  evidence. A score under 7/10 on any asset is a FAIL. "Looks fine" is not evidence.
- **Fixing.** Fix a FAIL. Do not argue it away unless frame evidence disproves it, and record that evidence.
  Re-run the round until both agents pass every item.
- **Disagreement.** When Gemini and a measurement disagree on sound, or the item is taste, mark it "cần tai
  Duy" (needs the user's ear). Send it as a short clip; do not decide it.
- **Identity checks.** Check every frame for a duplicated character or an extra person. Omni can insert a
  second copy of a character after a hidden cut.
- **Logs.** Keep one QA log per round in the plan's reports folder.
- **Independence.** Both agents get the same prompt; B never reads A's report. Two raters caught what one
  let through (both failed sc05 r2 at 7/10 on different items).
- **Output.** Each agent writes `qa-<a|b>-<date>-<cut>-r<N>-<sc>.json` next to its markdown, shaped
  `{"round", "agent", "render": {"file", "verdict", "score", "items": [{"rubric", "verdict", "t", "desc"}],
  "issues": [{"severity", "t", "frames", "desc", "fix"}]}}`, and ends its reply with a `Status:` line. Keep
  the final reply to about 10 lines; the detail lives in the files.
- **Pass rule.** A render passes when both agents pass every item, both score 7 or more, and no issue is
  high or medium ("cao"/"vừa"). Decide it with
  `python -X utf8 scripts/qa-gate-check.py qa-a-...json qa-b-...json`, not by re-reading both reports.
- **Intent notes.** A trade-off the user accepted goes into the rubric as an intent note: the reason, the
  frames, and what the viewer should read there. Without a note, QA re-flags it every round. An "intentional"
  claim with no note behind it is rejected.
- **Logic and blocking.** Check every beat against the script: who is where, who enters from where, whose
  hand is on the console. The user failed a cut on a stranger's arm on a console and a character who appeared
  in front of the hero instead of behind. AI-judge findings the agent waved away were not the user's bar.
- **Cadence.** Spawn the pair once per scene revision, not once per fix; batch the fixes first.

### 4. Human gates

G2 and G3 are where the user's eye is cheapest. Under `--auto` the agent runs the checklist below in their
place and logs a `decision`.

## The checklist (the bar the user applies)

Staging and physics
- Every figure has ground contact (feet on a surface, contact shadow, consistent scale with depth).
- Real perspective: the set recedes, the camera has height and angle; no flat side-on stage.
- Nothing that should be whole is cut by the frame edge (limbs, blades, hair, props).
- Weapon hand matches the character file; grip and blade direction make sense against the opponent's strike;
  the contact point is physically plausible.
- Facing and screen direction follow the 180-degree rule across cuts.

Acting and motion
- Faces act: eyes move, pupils and highlights respond, mouths match speech, hair and cloth have
  secondary motion.
- No limb or face morph in AI clips (check the last second of every Seedance or long Omni clip).
- Falls, catches and landings have anticipation, weight and follow-through; no abrupt jumps.
- An action sequence measures inside the reference band (`measure-reference-cut.py`, eight references):
  mean shot length 0.8-1.4 s, 44 or more cuts a minute, at most 15% of shots over 3 s, an impact frame
  every 10-20 s or more often, held share under 0.4. Outside the band is a finding to justify (a long take
  carried by FX wipes is one), not an automatic fail.

Compositing and look
- FX sit on the action (flash at the contact point, glints on the blade), measured not eyeballed.
- Additive light never clips the frame to white for more than a frame or two; particles read as what they
  are (petals, not snow).
- Grade is consistent across shots; no colour cast versus the raw frames.

Sound and text
- Every hit has a sound on its frame, landings have weight, dialogue sits above music.
- Hits are spotted on the contact frame, not snapped to the cut; major hits carry a low layer and a tail,
  and the bed under an action beat never drops to silence except for one or two deliberate suck-outs.
- Each location is heard: beds pass the `audit-mix-buses.py` gate and the user's ear (the gate alone failed
  once).
- Music cues end on a phrase or a tail, never on a cut.
- -14 LUFS (plus or minus 1), true peak at or under -1.5 dBTP, measured on every delivered file. Keep at
  least 0.3 dB of margin under the ceiling after the encode; sc03 shipped at -1.517 dBTP against -1.5 and QA
  flagged it.
- Captions readable at phone size (38px+ at 1080p, stroked), spoken and translated lines correct; HUD and
  screen text in a legible face (DSEG14 was illegible; Share Tech Mono worked) at 4.5:1 contrast or more
  (`hyperframes check` failed a 3.7:1 caption).

Episode packaging
- At least 5 minutes for an episode, with full script detail.
- Name cards introduce the characters, the episode ends on an end card, and an OST MV follows when asked.
- Overlays on a drawn screen sit in its perspective: corner-pin with `matrix3d` on a wrapper.
- Hard cuts that jar get a motivated transition (match cut, whip, light flash, a dissolve on a time jump).

## Scoring and retakes

Score the film out of 10 against the checklist and the reference feel, and say what keeps it from the next
point. The xianxia v1 scored 6/10: four defects (limb morph at 4-5s, flash off the contact at 7-8s,
abrupt fall at 8s, weak landing at 14.4s), estimated under $1.30 to fix. Netflix/ufotable grade means 8 or
more with no open staging or physics defects.

Retake order, cheapest first: reinterpret the beat (sound carries it, or a diegetic veil such as smoke,
rain on the lens or a passing body hides the flaw), re-cut (trim, speed, shot order), cover (FX, impact frame,
cel insert at the peak, cut-away), re-composite (FX position, density, grade), then a paid retake with a
stricter first/last frame. Two paid retakes of the same shot without a pass is a stop-and-ask, even under `--auto`. Trace every
retake with its cause tag.
