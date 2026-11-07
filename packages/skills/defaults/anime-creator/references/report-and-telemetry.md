# Process report, trace and run telemetry

Every film ships with a process report: what was done, what the agent decided alone, what broke and how it
was worked around, what it cost in cash and tokens, and what the next run should do differently. The trace
written during the run makes that report mostly mechanical, and the cross-run registry turns repeated
problems into skill improvements.

## During the run

```bash
S=scripts/anime-studio.py
python3 $S run-start $EP --transcript <session.jsonl> --note "15s xianxia duel, gated"
python3 $S phase $EP preprod                      # at the start of each phase
python3 $S trace $EP decision --detail "Omni native zh audio as VO; no TTS" --tag vo-source
python3 $S trace $EP workaround --detail "music sections merged to >=3000 ms" --tag music-section-short
python3 $S trace $EP error --detail "HTTP 429 at 5 parallel SFX" --tag el-concurrency --tool multix
python3 $S trace $EP retake --shot s15 --detail "sword never sheathed; first/last retake s15b" --tag omni-ignored-end-pose
python3 $S trace $EP qa_finding --shot s07 --detail "gemini: lips late -> rejected, lipsync -0.04s" --tag gemini-false-positive
python3 $S gate $EP G2 approved --note "auto: checklist passed"
```

The runner traces `gen_submit`, `gen_done` and `error` with cost and prediction ids by itself. Trace the
rest by hand at the moment it happens; a reconstruction at the end loses the reasons.

What deserves a trace line:

- `decision`: any choice the user did not make (tier of a shot, model, dropping a beat, a self-approved
  gate, rejecting a QA claim). One line: what and why.
- `workaround`: a tool or provider misbehaved and you went around it.
- `error`: a failed command or job, with the tool.
- `retake`: a paid or code redo of a shot, with the cause.
- `qa_finding`: a defect found (by measurement, Gemini, the agent's eye or the user), and its resolution.
- `note`: anything the report narrative will need (a measured number, a user preference).

## Tags (stable, short, reused across runs)

Use an existing tag when it fits; add a new one only for a new cause class.

| Area | Tags |
|---|---|
| Staging | `cut-off-limb`, `prop-cut`, `floating-figure`, `flat-staging`, `facing-wrong`, `grip-logic`, `contact-geometry` |
| Design | `off-model-keyframe`, `style-drift`, `too-many-refs` |
| AI video | `limb-morph`, `omni-hard-cut`, `omni-ignored-end-pose`, `omni-misread-hanzi`, `seedance-overrun` |
| Money | `price-trap`, `unused-footage`, `wasted-probe`, `network-blocked` |
| FX and look | `fx-misaligned`, `fx-overbright`, `particle-density`, `yuv-blend-magenta`, `abrupt-motion`, `layer-split`, `edge-wedge`, `stacked-fade` |
| Sound | `music-section-short`, `el-concurrency`, `weak-sfx-weight`, `limiter-squash`, `vo-timing`, `buried-ambience`, `aac-tp-overshoot`, `sfx-chopped` |
| Text | `caption-small`, `caption-wrong` |
| Process | `render-cpu-contention`, `zsh-glob`, `context-firewall`, `compaction`, `gemini-false-positive`, `user-caught`, `stale-bundle`, `render-oom`, `send-limit`, `parallel-writer`, `windows-shell` |

Add `user-caught` as a second trace line whenever the user found a defect the agent's QA missed; it is the
most valuable signal for improving this skill.

## Ledger and tokens

- `anime-studio.py ledger $EP` reads the billed price of every Atlas prediction in `logs/predictions.log`
  (`data.price`), merges non-Atlas jobs from gen-plan.json (ElevenLabs credits, fal) and caches the result.
  `--offline` uses the cache only.
- `anime-studio.py tokens <transcript>... --start <run start> --episode $EP` gives calls, input, cache write,
  cache read and output tokens per phase, deduplicated by message id, priced from the price table's
  `tokens` section (API-equivalent, assumed rates unless the user supplies real ones). Pass every session
  transcript of a run that resumed across sessions or accounts (FRONTIER EP01 spanned three); each one
  brings its subagents unless you pass `--no-subagents`.
- **Spend outside the ledger.** FRONTIER ep03 bought Seedance through a second reseller ($10.08) and Foley
  through fal, and neither reached the ledger, which also priced TTS from the table ($0.005 a call) instead of
  the billed $0.0009. Record every job bought outside the Atlas route in gen-plan.json with its billed price
  (a multix `Cost:` line, a balance delta) and re-run `ledger`; the report states which lines are measured
  and which are estimated.
- **Trace every phase and link the transcript.** ep03's trace had two `phase` events and `run-start` had no
  `--transcript`, so tokens per phase were counted by hand. Mark each phase as it starts and pass the
  transcript of every session (workers included) to `tokens` and `report`. That run cost $432.9 in Claude
  tokens (API-equivalent) against $6.82 of generation cash, 63 to 1, with the edit phase alone at $210; the
  per-phase split is how the next run finds where to save.
- Delivered files: `renders/deliveries.jsonl` (from `finish-scenes.py` and `assemble-episode.py`) has path,
  LUFS, true peak and size per file. Cite it in the report instead of re-measuring.

## Handoff between sessions

A long episode outlives a context window and sometimes an account. Before a planned stop, or when the
quota runs low, write a continuation note in `work/STATE.md` (see `orchestration-and-environment.md`). It
records:

- the goal and the bar, with the user's words verbatim;
- what is done, with the files and the measurements;
- what is open, and the exact next command;
- the files that must not be regenerated (hand-edited pages);
- the processes still running.

The next session reads it before anything else.

## The report

`anime-studio.py report $EP --transcript <session.jsonl>` fills `assets/templates/process-report.md` into
`$EP/reports/process-report-<run>.md`: outcome, phases with times, gates, decisions, workarounds, errors,
retakes, QA findings, ledger by kind, tokens by phase, cost per film second and video utilization. Then
write the narrative sections marked `<!-- agent -->` yourself:

- Outcome in two or three sentences, with the score and what holds it back.
- Per phase: what was done, which tools, what surprised you.
- Decisions taken alone and whether they paid off.
- QA: which claims were verified, which rejected, and how.
- Lessons: concrete, testable statements for the next run ("ElevenLabs music sections under 3000 ms fail
  with 422"), each also passed to `finish --lesson`.
- Open questions for the user.

Send the preview and the report together. Keep the report factual: measured numbers, paths, commands; no
claim without its measurement.

## Cost per accepted second

`anime-studio.py unit-cost $EP [--transcript <session.jsonl>] [--offline]` splits spend into five buckets:

| Bucket | Usage it reads | Rate (`rates` in the price table) |
|---|---|---|
| `media_usd` | the ledger | billed or estimated per job |
| `tokens_usd` | the linked transcript | the price table's `tokens` |
| `gpu_usd` | `wall_seconds` in the sidecar of every ComfyUI clip in the episode, run by a job or by hand | `gpu_usd_per_hour` |
| `storage_usd` | the episode's live catalogued bytes, held since `episode.json` `created`, plus the bytes `assets replicate` copied to a remote (`catalog/replicas.jsonl`; `adopted` copies are free) | `storage_usd_per_gb_month`, `egress_usd_per_gb` |
| `people_usd` | `hours` on trace events: `trace $EP human --detail "storyboard review" --set hours=1.5` | `people_usd_per_hour` |

The rates are what this studio pays, so none ships with a value. Put them under `rates` in
`<series>/price-table.json` (or the skill's). `usage` prints the measured quantities (GPU seconds, GB, months,
GB copied, hours) and `missing_rates` lists the rates still absent. A bucket is `null` both when nothing was
used (no local clip means no GPU time; no recorded hour means no people cost) and when something was used but
has no rate. Never `0`. `not_measured` lists every `null` bucket, and `unpriced_usage` lists the ones with
usage but no rate: those are the real gaps. Until `unpriced_usage` is empty, `cost_per_accepted_second` is a
floor. In `by_engine`, an engine's `gpu_usd` follows the same rule, and its `usd` is `null` while its GPU time
is unpriced.

Storage is approximate in two ways:

- Holding cost takes the episode's live catalogued bytes today as if held since `episode.json` `created`.
  A file added later counts from the start; a deleted or superseded file does not count at all.
- Egress counts each replica receipt once. What the remote charges to keep the copy is not counted.

It then divides that spend by **accepted seconds**: the seconds of generated video that the scene EDLs
actually show (shot end minus start, for a `src` or `src_raw` that a done video job or a ComfyUI run made, so
trimmed and upscaled shots count). It also prints `generated_seconds` (duration times takes per done video job,
`seconds` per ComfyUI sidecar) and `yield` (accepted over generated). A clip used by two shots counts twice,
so yield can pass 1.

`by_engine` repeats this per video engine: accepted and generated seconds, yield, clips, the ledger's video
spend and unpriced rows of that model, GPU seconds, and `usd_per_accepted_second`. A job that ran on the
runner's default model takes the model its ledger row was billed for. Read an engine A/B from this table.
`finish` adds `accepted_seconds`, `generated_seconds`, `yield` and `cost_per_accepted_second` to its runs row.

On frontier ep01, offline from the cached ledger on 2026-10-27, unit-cost reported:

- accepted seconds: 280.6 s, out of 431 s generated (yield 0.65);
- media: $41.59, or $0.148 per accepted second;
- tokens: $376.27 from the run's linked transcript, which brings the total to $1.489 per accepted second;
- unpriced Atlas predictions: 15.

Re-measured offline on 2026-10-27 with the buckets above, with no rates set and the series only read:

| Episode | Engine | Accepted / generated s | Yield | Video spend | Per accepted s |
|---|---|---|---|---|---|
| ep01 | gemini-omni-1.1-flash i2v | 182.1 / 291 | 0.63 | $28.81 (7 unpriced) | $0.158 |
| ep01 | minimax h3 i2v | 98.5 / 140 | 0.70 | $10.88 (2 unpriced) | $0.110 |
| ep02 | ComfyUI local | 257.0 / 847 | 0.30 | $0, 62,226 GPU s | unpriced: no GPU rate |

The ep01 episode holds 55.3 GB and copied 3.2 GB to a remote; ep02 holds 18.8 GB and copied 1.0 GB. No
people hours are recorded yet. The engines in this table did different shots, so it is not an A/B.
Switching a default engine on this number still needs a blind A/B and the user's approval.

## Closing the run

```bash
python3 $S finish $EP --score overall=7 --score acting=8 --lesson "trim before upscale; standard tier"
python3 $S insights
```

`finish` appends one row (length, cash, tokens, cost per second, utilization, gate rejections, retakes,
errors, tag counts, scores, lessons) to `<series>/runs.jsonl` and the studio root `runs.jsonl`. `insights`
aggregates all rows and lists tags seen in two or more runs.

## Asset health, context bytes and DoD records

Code: `scripts/studio/asset_observability_and_dod_gates.py`. Every command here only reads, except `--record`
and `dod record`, which append one line.

```bash
python3 $S observe $SERIES [--json] [--record --run <id>]    # catalog health; --record appends to catalog/metrics.jsonl
python3 $S context-bytes $EP [--transcript <jsonl>] [--json]  # tool-result bytes per trace phase and per tool
python3 $S dod record $SERIES scene ep01/sc01 scene.signoff PASS --approver Duy   # --kind human without the FilmSpec module
python3 $S dod status $SERIES scene ep01/sc01                 # exits 1 until the level passes
```

`observe` reports the following, per episode and in total:

| Metric | What it counts |
|---|---|
| time-to-find | ms of the first catalog load in this process, then the mean of at least 10,000 path lookups on the loaded state |
| resolve rate | share of the files the scene EDLs show (`src`, `src_raw`, `img`, `pick`) that resolve to a current record |
| duplicates | files and bytes held more than once by present files with the same sha256 |
| cache hit | share of current files whose size and mtime match `catalog/hash-cache.json`, which a scan skips |
| orphans | present files named by nothing: no child in the catalog, no episode JSON and no scene edit page (`index.html`, `*.js`); not pinned, rejected, a bible reference or a render. A path is read against the naming file's own folder, then its episode, then the series root, stopping at the first hit; JSON inside linked folders is read too |
| provenance unknown | keyframes, clips and audio with no producing job |
| licence unknown | files with no producing job and no entry in `catalog/licences.json` (`{path or asset_id: {licence, source, by}}`) |
| jobs | done jobs whose `out` is missing, or exists but is not catalogued (run `assets scan`); a gen-plan that cannot be read is listed, not raised |

`context-bytes` splits the transcript by the trace's `phase_start` events, the same way `tokens` does. It counts
text and images apart, because images are billed as pictures. Image bytes are the base64 length, about 1.33
times the decoded size. Lines that are not objects or carry no usable timestamp are skipped.

`dod` records DoD-1 to DoD-4 (asset, shot, scene, episode) in `catalog/dod.jsonl` as `PASS`, `FAIL` or
`WAIVED`:

- PASS and FAIL need `--evidence`: a command output, frames, timestamps or a measurement. A human check needs
  `--approver` instead. Blank values do not count.
- A hard check that the checklist ties to a gate command or a FilmSpec function needs evidence quoting that command
  (`validate: exit 0`, `filmspec: 0 failures`). The command is not run here.
- A check's kind is fixed by the checklist, or by the first record of that check when there is no checklist, so a
  later record cannot switch kind to dodge the evidence rule.
- WAIVED needs `--approver` and a reason in `--note`.
- `status` takes the latest result per check. When the FilmSpec module is installed, it lists the level's
  checklist, so a missing check reads `MISSING` and the verdict is `INCOMPLETE`. Without that module it reports
  the recorded checks only, and `--kind` is required.
- Hard, evidence and human results are counted apart and never averaged. One `FAIL` fails the level, and so
  does a hand-edited result that is not `PASS`, `FAIL` or `WAIVED` (it reads `INVALID`). Targets are compared
  without leading or trailing slashes.

The gates G0-G4 in `episode.json` stay the run's approval record. A DoD record is the evidence behind them.

Measured on the frontier series on 2026-10-27. The series was only read.

- `observe` took 1.6 s for 8,102 current assets (74.6 GB). Loading the catalog took 34 ms, and a path lookup
  took 0.025 us on average over 10,166 lookups. The first version took 32 s, because it asked the file system
  about every path that a JSON file names. It now compares those paths with the catalog's paths as strings.
- The resolve rate was 97.3% (582 of 598 EDL refs). The 16 misses are recap shots in ep02 whose `src` sits under
  `work/`, a folder the catalog skips. Those files are not backed by the catalog or its remote copy.
- There were 2,459 duplicate files (7.1 GB) and 3,754 orphans (7.4 GB). Before the scene edit pages were read,
  the count was 4,275 (11.6 GB); 521 of those are conformed clips that an `index.html` loads.
- The cache hit was 0% because the series has no hash cache yet, so the next scan reads all 74.6 GB.
- 4,094 generated files have no producing job, and 7,833 files have no known licence.
- 37 done jobs (in ep01) have outputs that are not catalogued.
- `context-bytes` for the ep01 run counted 4.7 MB of text and 214 MB of images in 3,181 tool results, all in
  one phase (`preprod`) because the trace marks no other phase.

## Improving the skill from telemetry

- A tag recurring in two or more runs is a candidate for a script check (the border-alpha `edge` check, the
  probe guard and the `gbrp` grade all came from repeated or costly failures) or a failure-mode line in
  SKILL.md.
- After a ledger shows a new billed price, update `price-table.json` with `basis: measured` and the date.
- When a workaround is needed twice, move it into the scripts and add a test under `scripts/tests/`.
- Keep `insights` output in the report of the next run so the trend stays visible.
