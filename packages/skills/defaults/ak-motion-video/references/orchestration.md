# Orchestration: operator and parallel sub-sessions, or `--poor`

A video is many pieces of unequal difficulty. Taste (concept, choreography,
"make this more tasteful") is judgment and earns the strongest model; running
scripts, splicing bars and authoring a scene against a written brief is labour
that a cheaper tier does well. The pipeline is also a dependency graph, not a
line: research, music and SFX do not wait for each other, and scenes can be
built side by side once TIMING exists. Default mode exploits both to finish
sooner and spend fewer tokens without lowering the bar.

| Mode | Who does what | Use when |
|---|---|---|
| Default | The **operator** (main session) pins the outcome, plans the waves, dispatches sub-sessions with a model and effort sized to each piece, integrates and verifies. Workers own disjoint files. | every new video or restyle, and "make this more tasteful" on an existing one |
| `--poor` | One session does everything; no sub-sessions or subagents; lean reads and one review round | the user wants the lowest token spend |

Partial reworks that change no visuals (new music, re-mix, re-render, social
encode, a quick-fit edition) skip direction and review in both modes, and
usually need no sub-session at all.

## Default mode

### Dispatch rules

- **Sub-sessions first.** Use the runtime's native sub-session facility, as
  `ak-atoz` does: each worker is a session the user can open and stop. Fall
  back to `delegate_agent capability` subagents when sessions are unavailable,
  and to running the roles one after another in the operator when neither
  exists (see "Degrade").
- **A piece is parallel-safe** when it needs no other piece's result, writes no
  file another piece writes, and does not have to be checked together with
  another piece. Everything else waits for its input.
- **Share the project directory, not worktrees.** Projects live under
  `assets/videos/<slug>/` with large generated audio and art that git does not
  carry; a worktree would start without them. Disjoint file ownership is what
  keeps parallel workers safe, so every brief lists the files the worker owns
  and forbids the rest.
- **Commands are not sessions.** A step that only runs a script (VO, SFX or
  music generation, `arrange-music`, render, social encode) runs as a tracked
  background process from the operator or the owning worker. Spend a session
  only where judgment is needed; every session pays to read the contract and
  profile before it does anything.
- **Batch small pieces.** A session per scene suits a long or hero-heavy video.
  For short videos or light scenes, give one builder a run of 2–4 adjacent
  scenes so the fixed reading cost is paid once. Keep each video's hero scenes
  (cover, drops, finale) with the builders that get the stronger setting.
- **Follow-ups go back to the same worker.** A fix round for a scene is a
  message to the session that built it, which already holds the context; a new
  session pays for it again.
- **A report is a claim.** Before integrating, check the files a worker wrote
  and the numbers it reports.
- **Pass the tier and effort, every time.** Set `model` and `effort` on each
  dispatch from the table below. A worker spawned without them silently runs
  on the operator's model, which is how one real run spent 56% of its tokens on
  scene builders that were all on the strongest tier. When the runtime cannot
  take them, see "Degrade".

### Model and effort per piece

Tiers are relative: strongest, mid and cheapest of what the runtime offers
(on Claude: Opus, Sonnet, Haiku). Effort is the reasoning budget where the
runtime exposes one. Raise a piece one step after a failed attempt; never
lower the reviewer.

| Piece | Tier · effort | Owns (writes) | Starts after |
|---|---|---|---|
| Fact scout (one per source group when sources are many) | cheapest · low | a facts report under `plans/reports/` | outcome pinned |
| Style bake-off candidate (one per style) | mid · low | `bakeoff/<style-id>/` | style still open |
| Director: brief and script edits | strongest · high | nothing; returns text the operator saves | `data/script.json` draft |
| Sound designer: SFX list and music plans | mid · medium | `data/sfx.json`, `data/music-plan.json`, `data/outro-plan.json`, `assets/audio/{sfx,music}/` | script draft and base style |
| Art builder (only when the style bakes art) | mid · medium | `assets/images/<scene-or-layer>*`, `data/art.json` | `data/direction.md` |
| Timeline: align, beat grid, arrangement, mix | mid · medium | `data/vo-lines.json`, `data/music-arrangement.json`, `data/cues.json`, the `EDIT` block of the project's `build-timeline.mjs`, the project's `mix.m4a` and stems | VO and music generated |
| Caption editor (recording mode, one per ~150 segments) | cheapest · low | `data/captions-vi.<batch>.json` | segments and the EDL |
| Scene builder (one per run of scenes) | light types (quote, chips, list, title) mid · medium; diagrams, UI demos and charts mid · medium; hero scenes mid · high | `scenes/<sid>.scene.html` for its scenes only | TIMING injected and the shell built |
| Assembler | mid · medium | `index.html` (the shell), `builds/`, `renders/`, contact sheets | the shell: after the timeline; the splice: after the builders |
| Taste reviewer | strongest · high, fresh context | nothing; returns review notes | first draft contact sheets |
| Edition builder (one per ratio) | mid · low | its edition directory | master passes "Done when" |

The operator keeps `data/script.json`, `data/style.json`,
`data/direction.md`, the plan and the final verification. VO generation runs
from the operator once the script is final, because the director's edits change
it.

### Waves

```text
0  operator: scripts/doctor.py → data/env.json (the brief line every worker gets)
1  operator: outcome, scaffold                           ║ fact scouts, bake-off candidates
2  operator: script.json from the facts, style resolved
3  director (brief + script edits)                       ║ sound designer (SFX list, music plans, generation)
4  operator: apply edits, save data/direction.md, generate VO   ║ art builders
5  timeline worker → TIMING injected; assembler builds the shell (helpers, WINDOWS, captions, HUD, signature, beat reactions)
6  scene builders, all in parallel
7  assembler: splice fragments, lint, check, draft render, one contact sheet per scene
8  taste reviewer → notes routed to the owning scene builders → assembler re-renders touched scenes (at most two rounds)
9  assembler: final render, remux, checks, social encode   ║ edition builders
10 operator: verify every "Done when" item
```

`║` marks pieces that run at the same time. A wave starts as soon as its
inputs exist; it does not wait for unrelated pieces of the previous wave.

In the recording mode (`recording-pipeline.md`), waves 2–5 become: transcribe →
segments → the operator writes the EDL, the script and the short candidates →
apply and check the EDL ║ caption editors → timeline and mix. Waves 6–10 are
unchanged, and each part of a long video is assembled and rendered on its own.
Shorts are rendered only after the user approves the master.

### Scene fragments

`index.html` is the shell, and builders never edit it. Each builder writes one
file per scene, for its own scene ids only: `scenes/<sid>.scene.html`. That
file holds the scene's `<section id="scNNN" class="scene layer">`, one
`<style>` with rules scoped under `#scNNN`, and one `<script>` with the body of
the scene's choreography. The script uses only the shell's helpers (`W`, `B`,
`pop`, `slam`, `settleCam`…) and `rng(seed)` with a seed unique to the scene.
Shared tokens stay in the shell and are read-only. One file per scene is about
15 Write calls per builder instead of 40–70.

- The operator runs `scripts/scaffold-scenes.py <project> --scenes a..b` before
  the builders start, so each builder fills stubs instead of creating files.
- Every 3–5 scenes, a builder runs the fast check on its own range:
  `scripts/assemble.py <project> --scenes a..b --tag tmp-<builder>`, then
  `scripts/validate.py builds/tmp-<builder>`. That runs lint and check only,
  with no render and no snapshot. It fixes layout, contrast and runtime errors
  while the scenes are still in context.
- Builders query timing with `scripts/tl.py` (`scene`, `words`) and never read
  `data/timeline.json` raw.
- When `data/shorts.json` lists one of a builder's scenes, the builder also
  writes that scene's `html[data-ratio="9x16"] #scNNN …` overrides, using the
  safe areas in `reframe.md`, and checks them with
  `scripts/check-bounds.mjs builds/tmp-<builder> --ratio 9x16` on a 9:16 tmp
  build (`assemble.py … --ratio 9x16`). It renders nothing in 9:16.
- Builders do not open the shared browser pane. Parallel builders share one
  pane and hit `file://` blocks and tab caps. `check-bounds.mjs` and
  `contact-sheet.py` run headless.

The assembler splices the fragments in script order (`scripts/assemble.py`)
and owns the `WINDOWS` table, so transitions and the handoff between scenes stay
consistent. A builder that needs a new shared helper or token asks the
operator; it does not add its own copy. Full builds, snapshots and renders run
only in the assembler, one render at a time on the machine.

### Direction brief (`data/direction.md`)

```markdown
# Direction: <slug>
Concept: <one sentence: the visual idea that ties the piece together>
Story: arc <id> · hook <pattern> · ending <kind> (story-and-shots.md)
Base: <style id> · energy <n> · juice budget <from motion-craft.md>
Locks: palette <tokens> · type <families/weights> · signature untouched
Motif: <a shape, motion or colour that recurs and evolves across scenes>
Rhythm: <per scene: calm | build | drop | breathe, with the drops>
Taste rules: <3–6 things this piece never does>

## <sid> · <scene type> · <role in the rhythm>
- Shot: <size> · <camera move> · cut-in <on word → size, if the scene runs past ~7 s>
- Focal beats: <word or drop> → <where the eye goes>
- Hero moment: <cookbook technique> on W(<sid>, "<word>") or drop <n>
- Entrances: <element> → <verb>, <ease>, <overlap with the lead>
- Depth: <bg / mid / fg>, hold motion <settleCam, drift, sweep>
- Exit: <handoff into the next scene: match-move, whip, wipe, zoom-through>
- Avoid: <scene-specific don'ts>
```

The brief names moments by spoken word and by drop, not by seconds, so it does
not need TIMING. Each scene builder receives the header and only its own scene
sections, plus the neighbours' Exit lines so handoffs match.

### Taste review notes

```markdown
## Review <n>: revise | ship
Keep: <what already works; the builders must not lose it>
1. [<sid> @ <s>] <what reads as demo or clumsy> → <the change, as a cookbook recipe or an exact ease/duration/offset>
2. ...
```

At most eight notes, ranked by visual impact. "Make it more premium" is not a
note; "s02 @ 5.9: the 40% lands flat; slam on W(s02, "faster") and push the
camera 1.00 → 1.04 through the hold" is. The reviewer runs in a fresh session
that has never seen `index.html` source: input is `data/direction.md`, the
sheets, one or two downscaled hero snapshots and the deviation list. The
operator appends each review to `data/direction.md` and routes each note to the
builder that owns the scene.

### Briefs

Give each worker a self-contained brief with paths, never the conversation.
`<skill>` is this skill's directory and `<project>` the video project.

```text
Goal: <piece>, for the video in <project>, with the skill at <skill>.
Env: <the brief line from data/env.json, e.g. "Shell: pwsh. Python: `python -X utf8`. Write files with Write/Edit, never heredocs.">
Read: <only the references this piece needs, e.g. composition-contract.md,
  motion-craft.md (cookbook + director's pass), the base profile, the brief sections>.
Inputs: <files it reads>.  Owns: <files it may write>.  Must not touch: everything else.
Done means: <its checks, e.g. node --check on its fragments, verify-arrangement ±2 ms>.
Return: ≤ 15 lines: changed paths, check results, deviations from the brief with a reason each,
  then "Status: DONE | DONE_WITH_CONCERNS | BLOCKED" and one line of summary.
Stop and report instead of guessing when an input is missing or wrong.
Harness: do not call update_plan or wrap_up; wait for background tasks through their
  notifications, never sleep loops (Start-Sleep, sleep); create no files outside "Owns",
  none in the project root; keep each file's existing line endings.
```

`scripts/doctor.py <project>` runs first in every video and writes
`data/env.json`. Its brief line goes into every brief verbatim. On Windows it
records whether Git Bash works (a broken profile kills every Bash call with
`Exit code 2`) or PowerShell has to be used, and whether Python needs `-X utf8`
to print Vietnamese. Never write files through heredocs; the file tools do not
depend on the shell.

### Operator hygiene

The operator's context is the scarcest resource on a long video, and every
compaction loses decisions.

- Long command output goes to a log file and is read with `tail` or a search,
  never printed whole. Renders, `check` and builds always log to a file.
- Worker reports stay at 15 lines or fewer and end with a Status block. Ask
  for the full detail only when a check fails.
- Review one contact sheet per short or part, not per scene. Open single
  scenes only where the sheet shows a problem.
- Keep decisions in the plan (`data/direction.md`, the parts and shorts
  tables), not only in the conversation, so a compaction does not lose them.

### Quota, machine and cleanup

- Check remaining usage before each wave when the runtime exposes it. Start
  with two or three concurrent workers, widen while usage and machine load stay
  comfortable, and narrow before a limit. A rate-limit pauses new dispatches; it
  does not stop the run.
- Renders and snapshots run headless Chrome and saturate the machine: one at a
  time, from the assembler or an edition builder. Only the operator starts a
  studio preview, as a tracked background process it stops at the end.
- Track every process and session the run starts. Stop finished workers'
  processes, delete scratch renders and stems once the final render passes, and
  keep the project's deliverables.

### Degrade

- **No sub-session facility:** dispatch the same pieces as `delegate_agent
  capability` subagents with the same briefs and file ownership.
- **Workers cannot take a per-piece model or effort:** keep the pieces and the
  files, and tell the user in one sentence that every piece runs on the same
  model.
- **No dispatch at all:** run the waves in order in this session. Still save
  `data/direction.md` before building, still write scene fragments one scene at
  a time, and still review sheets against the brief before the final render.

Output from cheaper tiers is checked, not trusted: the operator reads the
reported numbers, looks at one sheet per scene, and the reviewer sees every
scene at least once.

## `--poor` mode

One session, no sub-sessions or subagents, and every step kept to the fewest
tokens that still meet "Done when". The session model is whatever the user
runs; the skill does not switch it.

- **Direction:** write a compact brief into the plan: the concept line, the
  taste rules and one line per scene (shot size and camera move, hero technique
  and exit). Skip the full per-scene template.
- **Reads:** the base profile, the contract sections you are using, and the
  technique cookbook and director's pass of `motion-craft.md`, and the shot
  vocabulary and anti-monotony rules of `story-and-shots.md`. Read reference
  style files only for the scene types you build. Read `index.html` back by
  line range or search, not whole.
- **Composition:** author scenes directly in `index.html`; reuse the skeleton
  helpers and the reference demo's choreography for repeated scene types
  instead of inventing new ones.
- **Review:** one draft render and one contact sheet for the whole video
  (`fps=2,scale=240:-1,tile=8x<rows>`), one fix round, snapshots only where the
  sheet shows a problem. Run the director's pass once as a self-check.
- **Audio:** one music generation; fix drop timing by splicing bars
  (`audio-and-beat-sync.md`), not by regenerating.
- **Editions:** re-layout only when the user will publish the edition;
  otherwise the ffmpeg quick fit from `reframe.md`, and say which one you used.

`--poor` never skips lint, check, the audio checks or the final ffprobe,
loudness and blackdetect checks.
