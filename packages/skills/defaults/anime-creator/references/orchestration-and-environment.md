# Orchestration, environment and quota

Most parallelism in this pipeline is free: generation APIs run asynchronously while the agent builds the
GL shots and the edit. Agent-level parallelism (subagents, extra sessions) costs tokens, because each worker
re-reads context; it pays only for self-contained work on a long episode.

## Phase graph

```text
interview -> G0 -> designs (sheets, set, layers) -> G1
  -> keyframes (async batch) -> keyframe QA -> G2 animatic (keyframes cut to timing, 360p previz optional)
  -> submit all T2/T3 video at once (after the price probe)
       while it renders: GL sets, weather and FX cues for T0/T1 shots; SFX and music; captions
  -> fetch -> clip QA -> trim -> upscale -> conform -> build -> draft render -> temp mix -> G3
  -> fixes -> delivery render -> mix -> grade test -> grade -> QA -> report -> G4
```

Phase names for the trace: `preprod`, `keyframes`, `video`, `conform-upscale`, `gl-edit`, `audio`,
`master-qa`. Mark each with `anime-studio.py phase <ep> <name>` so tokens and time split per phase.

## When to delegate

| Work | Delegate? | Why |
|---|---|---|
| Async generation jobs | no agent needed | the runner submits; `--fetch` collects |
| Sound design for a scene (spotting sheet, SFX jobs, music plan, mix events) | yes, one Sonnet subagent | self-contained with the EDL and a context pack; verifiable by `loudness` and listening |
| FX cues and camera for one scene of a multi-scene episode | yes, with `context-pack` output and the scene dir | owns only `scenes/scNN/src/scene/` |
| Interview, scope, gates, budget, final QA, report narrative | never | needs the user and the whole picture |

Rules that came from failures:

- One or two Sonnet subagents at a time for open-ended work. More are fine when each owns disjoint output
  files: five per-scene sound designers writing `mix-add-<scene>.json` proposals ran together without
  conflicts. Do not run monitoring loops that wake one agent to check on another.
- **Size fan-out to the Claude quota.** A QA agent costs about 150k tokens, a scene builder about 240k.
  "Can it go faster?" was once answered with 19 agents on the default model; the session limit hit after
  1h48m, mid-QA, with no handoff. Say the quota cost when asked to speed up, cap concurrency at about 4, and
  pin a cheaper model for builders and QA where taste allows.
- **Handoff before the limit.** After the second compaction, or when the 5-hour or weekly window is near
  (about 80% used), bring the episode's `work/STATE.md` up to date as the handoff (below) before any new
  fan-out. FRONTIER ep03 compacted six times without one and built the handoff ad hoc when the account ran
  out; one path means the next account or agent knows where to look.
- **Resume, do not respawn.** A "session limit" notification means: after the reset, resume the same agents
  with SendMessage (load it with `ToolSearch select:SendMessage`), not new ones that re-read everything.
- **Builders stop at about 200 turns.** Brief them to batch commands, write a progress note to their scene's
  `work/` folder as they go, and report the exact next command when they stop.
- **QA replies stay short.** Ask for about 10 lines plus the report paths; long QA replies arriving as
  notifications caused five compactions in one session.
- **Fix shared defects before the forks start.** A frame-snap, true-peak or caption-clamp fix that lands
  after the scene builders have built forces every scene to re-finish.
- Give each worker: the files it owns, the files it reads, exact output paths, measurable acceptance
  (durations, LUFS, frame counts), and "return findings as text". A harness refused subagent report files.
- Verify every delegated result yourself (ffprobe, `loudness`, a strip) before building on it; one audio
  subagent's mix needed a controller fix round (shout retimed, opening lifted, a crackle replaced).
- For an episode of four or more scenes, separate sessions per scene (each in its own worktree or scene
  directory) are an option when the user wants speed over quota. The controller keeps episode.json,
  gen-plan.json, the mix and the grade. Multi-agent workflows run only when the user opts in to their cost.

### Worker sessions and watching them

An episode split across sessions (voice, keyframes, GPU queue, sound, edit) stalls between them unless the
controller watches for completion itself. On FRONTIER ep03 the pipeline sat idle for 2.5 hours after the GPU
queue finished and 12 hours after sound finished, an edit session stopped silently overnight, and the first
cut reached the user 4.5 hours after it was assembled; each time the controller waited for a session event
that never came.

- **Start every worker session in the user's turn**, before the user leaves. The desktop app refused to start
  a session during the autonomous continuation, so the edit role had to be handed to another session.
- Pass `cwd` in the platform's native form (backslashes on Windows); a forward-slash spelling of the same
  folder was rejected.
- **Every worker writes a `.done` marker** (`work/<role>/<item>.done` with its output paths) when an item or
  its whole queue finishes, and a heartbeat file while it runs. The controller watches those files with a
  background watcher that exits on the next marker, so the exit wakes it; it does not wait for chat events.
  A Monitor-style watch expired after 30 minutes on ep03, so prefer a watcher whose exit is the signal, and
  re-arm it each time.
- On each wake-up, start the next phase that the marker unblocks and send any finished deliverable at once.
- Stop the watchers and tails you started; stray `tail -f` processes outlived the run.
- Keep QA briefs and rubrics under the episode (`work/qa/`), and pass absolute paths to `qa-gate-check.py`;
  a brief in a session-local temp folder was invisible to the other session.

## Environment awareness

`anime-studio.py preflight` before heavy phases: tools and versions, free disk and memory, 1-minute load,
heavy processes already running (headless Chrome, ffmpeg, hyperframes), ports in use, whether the multix env
file and its keys exist (never their values), and a suggested render worker count (memory / 1.2GB per worker,
at most cores/2 and 4, and 1 when load exceeds the core count).

- Another session's heavy job counts against you. If the machine is loaded, render with one worker or wait;
  do not stop processes you did not start.
- Work and temp files on the big volume (`TMPDIR` there); masters are 110-155MB, frame caches larger.
- Run renders, grades and long ffmpeg jobs in the background with the host's completion notification;
  foreground sleeps are blocked in some hosts, so wait on the notification, not a timer.
- One heavy job at a time. Fixed port per project for previews; stop what you started at the end; kill only
  with narrow patterns (`pkill -f "<project>-v1"`), never broad ones.

## Claude quota and token cost

Measured: one 15.7s film cost 169 API calls and 31.85M tokens, about $22.84 API-equivalent with 68% of it
cache reads (each call re-reads about 190k of context). That is about 6x the cash spent on generation.

- Check the plan's remaining 5-hour and weekly allowance before a long run (host usage tool if there is
  one, otherwise ask the user) and size the run to it; say when an episode will need more than one window.
- `anime-studio.py tokens <transcript.jsonl> --start <ISO run start> --episode <ep>` meters usage mid-run,
  split by the trace's phase starts (subagent transcripts included unless `--no-subagents`).
- Cheapest levers: reuse the engine and scripts (GL and edit phases cost about $5 each when written from
  scratch), keep tool outputs small (min/max instead of arrays, sheets instead of many frames, jpg previews),
  read references only when their phase starts, and hand subagents a context pack instead of the bible.

### What an episode really costs (FRONTIER EP01, about 7.6 min)

The whole EP01 run took sessions across three days. Measured:

| Session | Calls | Cache-read tokens | Notes |
|---|---|---|---|
| first (cut 1 and cut 2) | 1,263 Bash calls | n/a | 218 image reads, 21 compactions, the uv `PATH` export retyped 206 times |
| continuation 1 | 672 | 130M | |
| continuation 2 (cut 3) | 1,319 | 263M | |

- The cut 2 run alone came to $951.68 API-equivalent.
- Images were about 99% of the characters the agent read.

The levers that cut this, in order of size:

1. **Look at less.** Contact sheets under 300 KB, zoomed crops of the flagged region, `qa-prescan.py`
   output instead of frames. Never read a full 1080p frame to check one edge.
2. **Script the loop once.** The render, grade, 720p and share loop was retyped per scene and per round. Use
   `finish-scenes.py`, `assemble-episode.py`, `merge-mix-proposals.py`, `audit-mix-buses.py` and
   `qa-prescan.py`. Put the environment setup (`PATH`, `NODE_OPTIONS`, `-X utf8`) in one sourced file, not
   in every command.
3. **Fix audio without rendering.** An audio-only fix is a remux of about a minute
   (`finish-scenes.py --video-from`). A picture fix renders only the scenes that changed.
4. **Delegate the parallel parts to cheap models.** One Sonnet sound designer per scene, writing JSON
   proposals that the controller merges, was the cheapest pattern of the run. Subagents stop at about 200
   turns, so give each a bounded scope.
5. **Measure before the agents look.** Run the prescans before spawning QA agents, and give them the numbers.
   Prefer a number (block difference, luma, onsets) to an image whenever one answers the question, and keep
   every image under 300 KB before reading it.
6. **Read sources by range.** Never cat a whole engine or template file (15-21k characters each); grep for
   the function and read its lines. The helper tables in `gl-compositing-and-fx.md` are the API cheat sheet.
   Read the script once into `work/beats.json` (see `interview-and-scope-gates.md`).
7. **Mine logs with Python.** Parse transcripts and JSONL with a short Python script; a grep over a 194 MB
   transcript had to be killed, and searches kept matching the search command itself.
8. **No hard-coded paths in generated scripts.** Take the episode dir as an argument; a script pinned to an
   old worktree path cost four refused edits before the state was copied over.

## Cache and reuse

- `gen/` is append-only: a retake gets a new id (`s15b`), the old take stays for comparison and for the
  ledger.
- Submitted Atlas predictions survive a crash (`predictions.log` + `--fetch`); the ledger caches billed
  prices in `logs/ledger.json`.
- Reuse approved sheets, set layers, voices and seeds across episodes; reuse SFX libraries per series in
  `audio/sfx/`.

## Credentials and network

- Keys come from the environment (in a Studix sandbox, Studix injects the workspace's Multix keys); on a
  workstation they live in `~/.multix/.env`. Load quietly (`set -a; source ~/.multix/.env >/dev/null 2>&1; set +a`),
  check presence with `grep -c`, never print values. Filter command output with
  `grep -v -i -E "api.?key|xi-|bearer"`; a plain `-i key` filter also hid every "keyframe" cost row. The
  runner redacts its job logs.
- multix calls need network access; some hosts require running them outside the command sandbox.
- Probe each new provider with one tiny call, including the download: one host's output URLs were
  unreachable after the job was paid. Python requests to Atlas need a non-default User-Agent (a default one
  got HTTP 403). Prefer local models (depth ONNX) when a download domain is blocked.

## Tool versions and shell traps

- Pin multix with npm (`npm i -g @mrgoonie/multix@<version>`); `multix update` failed. Pin HyperFrames
  (`npx -y hyperframes@0.8.77`). Call codex by absolute path.
- zsh: unmatched globs abort (`(N)` qualifier or `find`), `${@:-a b c}` does not split (use an array),
  `wait -n` is unreliable (use `xargs -P`), `${=var}` to word-split a command string, quote URLs with `?`.
- macOS has no `timeout`; scripts that `cd` break relative paths (use absolute ones); `chmod +x` generated
  scripts; ffmpeg `vstack`/`hstack` need `inputs=N`.
- The host's browser pane may be hidden (zero-size viewport); review frames with `snapshot`, `sheet` and
  `strip` instead of screenshots.

### Windows (FRONTIER ran on Windows 11 with Git Bash)

Each of these traps cost at least one failed step:

- **uv on PATH.** Append the uv directory to `PATH`, never prepend it: `export
  PATH="$PATH:$HOME/AppData/Roaming/Python/Python314/Scripts"`. Prepending shadowed the multix shim.
- **UTF-8.** Run Python as `python -X utf8`. Vietnamese text crashed the default cp1252 console encoding.
- **Paths for ffmpeg and Node.** Pass `D:/...` paths (`cygpath -m`), not `/d/...`, which Windows ffmpeg
  resolved to `C:/d/...`. Concat lists need absolute forward-slash paths.
- **npm shims.** `.CMD` shims (npx, multix, hyperframes) run from Python only through `shutil.which`
  (`io.resolve_cmd`), never as a bare name.
- **A CLI that PATH cannot run.** Version managers (fnm, nvm, volta) put node and global packages in
  per-shell folders, so a shim can resolve to nothing or to another install. Set `ANIME_CLI_<NAME>` to the
  command that works, such as `ANIME_CLI_MULTIX="node /path/to/multix/dist/cli.js"`; `io.resolve_cmd` uses it
  in place of the bare name. Never write such a path into a script or a reference.
- **Null output.** Use `-f null -` for ffmpeg's null output, never `NUL` or `/dev/null` as a file.
- **Hangs.** `tasklist` hangs inside Git Bash; use PowerShell's `Get-Process`.
- **Heredocs.** Heredocs with quotes, `$` or backslashes broke. Write the script to a file, then run it.
- **Pipes.** Use `set -o pipefail`. A pipe into `tee` once hid an exit 127.
- **Background renders.** Run one at a time through the host's background facility, which shows when they
  exit. Do not use detached `&` jobs.
- **ffmpeg filter paths.** A `C:` in `metadata=print:file=` breaks the filter parser: cd to the folder and
  pass a relative path. An image2 tile needs `-frames:v 1`. Always pass `-nostdin`.
- **Node.** `node --check` on an ESM file needs a `.mjs` copy (Node 24 has no `--experimental-default-type`).
- **Noise.** "Fontconfig error" lines from drawtext are harmless.

## Long runs: state, locks and handoff

- **State file.** Keep `work/STATE.md` in the episode: the current round, what is rendered, what is
  approved, what is open, which files are hand-edited (an `index.html` that `build` must not regenerate),
  which worker sessions exist and what each owns, and the exact next command. It is also the handoff: a
  compaction, a new session or another account reads it first.
- **Deliverables manifest.** `renders/deliveries.jsonl` (written by `finish-scenes.py` and
  `assemble-episode.py`) lists every delivered file with its measurements. When the user asks for "the last
  link", answer from it. The user had to ask twice for a link the agent could not find.
- **Locks name their owner.** Render and merge locks hold "<pid> <what>" (`io.take_lock`). A lock whose PID
  is not running is reclaimed, with a line saying so; a live owner is waited on (`finish-scenes.py`
  waits for a render lock up to 6 hours). Twice on FRONTIER ep02 a render stalled on a lock whose owner had
  died; both were deleted only after the owner PIDs proved dead. Do the same for any lock you meet:
  check the PID (`Get-Process -Id` on Windows, `ps -p` elsewhere), never its age.
- **One writer per shared file.** Shared files are `edl.json`, `mix-events.json` and `episode.json`. Parallel
  align jobs corrupted `edl.json`. Give parallel workers per-scene files and merge them with a lock
  (`merge-mix-proposals.py`).
- **Two copies of the engine.** The series engine (`<series>/engine/src`) and the skill's copy drift.
  `finish-scenes.py` compares them before each render; `--strict-engine` stops on a difference.
- **Command log.** For a multi-day episode, keep a short log of the commands that worked, so the next
  session reuses them instead of rediscovering them.
