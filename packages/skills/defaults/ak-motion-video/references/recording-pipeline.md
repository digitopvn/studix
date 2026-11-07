# Recording-driven pipeline (`--from-recording`)

Use this mode when the voice is the user's own recording (talking-head takes,
a screen-share narration, a podcast cut) instead of a generated voice-over. The
motion graphics carry the screen; the speaker appears as a small webcam
picture-in-picture (PiP). The composition contract, scene fragments, checks and
"Done when" stay the same as the TTS mode. Only the audio front end changes.
Recording, transcript and EDL replace the TTS, forced alignment and bar
splicing steps.

Every step is a bundled script under `<skill>/assets/templates/recording/`.
Each one runs straight from the skill with the project as its first argument,
so the project holds data, not pipeline code:

```bash
R=<skill>/assets/templates/recording
python -X utf8 $R/<step>.py <project> [options]     # every step has --help
```

Long-form recordings make big files. Do not read `data/transcript.json`,
`data/segments.json` or `data/timeline.json` whole. Read the tables the scripts
print, or query the files with `scripts/tl.py`.

## Steps

| # | Step | Reads | Writes |
|---|---|---|---|
| 0 | `python -X utf8 <skill>/scripts/doctor.py <project> --mode recording` | the machine | `data/env.json` and the one-line brief for every worker |
| 1 | `transcribe.py` | `raw/<take>.*` | `data/transcript.json` (word times in source seconds) |
| 2 | `segments.py` | transcript | `data/segments.json` plus a table: id, take, window, first words |
| 3 | operator writes `data/edl.json` | the segments table | the keep list (segment ranges or raw windows, an optional speed) |
| 4 | `apply-edl.py` | takes, EDL | `./assets/audio/voice.wav`, `./assets/video/webcam.mp4`, `data/edl-map.json` |
| 5 | `check-edl.py` | the outputs of step 4 | a drift report; exits 1 when audio and video drift apart |
| 6 | operator writes `data/script.json` (`mode: "recording"`) and plans the shorts | the segments table | scenes as segment ranges, `data/shorts.json`, `data/parts.json` |
| 7 | caption editor (cheapest tier) writes `data/captions-vi.json` | segments, `captions-vi.md` | one Vietnamese caption per segment |
| 8 | `build-timeline.py` | script, segments, EDL map, captions, optional beat grid | `data/timeline.json`, `data/vo-envelope.json`, TIMING injected into `index.html` |
| 9 | `mix.py` | voice, optional music | `./assets/audio/mix.m4a` at −14 LUFS / −1.5 dBTP, voice and music stems |
| 10 | `<skill>/scripts/scaffold-scenes.py`, then the scene builders | timeline, brief | `scenes/<sid>.scene.html` |
| 11 | `<skill>/scripts/assemble.py --tag <part> --scenes a..b`, then `validate.py` | shell and fragments | `builds/<tag>/` with lint and check passing |
| 12 | render each part, then `finish.py` | build, webcam | the final MP4 with the PiP and the untouched mix |
| 13 | after the user approves the master, `shorts.py build`, then `render`, then `probe` | `data/shorts.json` | `renders/shorts/<id>.mp4` |

### 1. Transcribe

```bash
python -X utf8 $R/transcribe.py . --language vi            # ElevenLabs Scribe through multix, one JSON per take
python -X utf8 $R/transcribe.py . --engine whisper-json --import take1.whisper.json --take take1   # offline
```

ElevenLabs Scribe through `multix elevenlabs transcribe` is the default. It
uses the same provider and the same multix credentials as the TTS mode's
forced alignment. A local Whisper or faster-whisper JSON with word timestamps
also works. Put the takes in `raw/` and never edit them.

### 2–3. Segments and the EDL

`segments.py` splits the words into sentences at end punctuation, at pauses
longer than 0.6 s, or every 40 words. It numbers them `g001…` across all takes.
Read its table, drop retakes, false starts and filler, and write the keep list:

```json
{ "speed": 1.08, "pad": 0.08, "keep": [
  { "segments": "g001..g014" },
  { "segments": ["g016", "g018"], "speed": 1.15 },
  { "take": "take2", "from": 12.4, "to": 31.9 }
] }
```

`speed` speeds up the speech, with pitch preserved through `atempo`. Use
1.05–1.12 for a natural lift and up to ~1.2 for rambling passages. `pad` keeps
breath around each cut.

### 4–5. Apply and check the EDL

`apply-edl.py` cuts the audio and the webcam video to the same whole-frame
lengths, so they cannot drift. It writes `edl-map.json`, which maps source
time to edited time. That map is what keeps every word time valid after the
cut. Always run `check-edl.py` before building the timeline. A failure there
shows up as lip-sync drift in the PiP later.

### 6. Script, parts and short candidates

A recording-mode scene is a range of kept segments:

```json
{ "mode": "recording", "scenes": [
  { "id": "s001-hook", "type": "title", "shot": "close · push-in", "title": "Ba lỗi khiến video tốn gấp đôi", "from": "g001", "to": "g002" },
  { "id": "s002-problem", "type": "list", "from": "g003", "to": "g006" }
] }
```

Size scenes with `story-and-shots.md` (about one idea and 4–12 s each). For a
video longer than ~10 minutes, split it into parts of ~40–60 scenes in
`data/parts.json` (`[{ "tag": "p1", "scenes": "s001..s040" }]`). Each part is
assembled, checked and rendered on its own.

Pick the short candidates now, while planning, not after the master (see
`reframe.md`). Choose them from the transcript: a self-contained claim with a
hook in its first line, 20–60 s, as a scene range:
`[{ "id": "01", "title": "…", "scenes": "s012..s018" }]` in `data/shorts.json`.
The builders of those scenes then write the 9:16 overrides while they still
hold the context. Nothing is rendered in 9:16 until the user approves the
master.

### 7. Captions

Captions come from `data/captions-vi.json`, one edited Vietnamese caption per
segment id. `build-timeline.py` chunks each caption to ≤ 9 words and spreads
the chunks over the segment's word onsets. Without the file, captions fall back
to the spoken words. Caption editing is the cheapest-tier job in
`captions-vi.md`. Give it batches of ~150 segments and the term list.

### 8. Timeline

```bash
python -X utf8 $R/build-timeline.py . --dry     # the schedule only
python -X utf8 $R/build-timeline.py .
```

The output has the same TIMING shape as the TTS mode (`composition-contract.md`)
plus `"mode": "recording"`, so `W(sid, word)`, the captions, the scene windows
and the envelope-driven motion all work unchanged. With
`data/music-arrangement.json` (`bpm`, `beat0`), scene starts snap to the
nearest beat within ±0.25 s. Without it, `kick` and `drops` are empty and beat
reactions stay idle. Read every warning: a scene with no kept words, a segment
used twice, a scene shorter than 1.5 s or longer than 20 s.

### 9. Mix

```bash
python -X utf8 $R/mix.py . --music ./assets/audio/music/bed.mp3 --music-db -20
```

`--music-db` is the bed's loudness in LUFS before ducking (the voice is
levelled to −16 LUFS first), and `--duck-db` is how far it dips under speech
(default 8). The music bed loops under the voice and ducks with a sidechain. The result is
normalised to −14 LUFS / −1.5 dBTP. The stems (`stem-voice.wav`,
`stem-music.wav`, the music with a 2 s tail) let each short end on a music tail
instead of a hard cut.

### 10–11. Build and fast-check scenes

Run `scaffold-scenes.py . --scenes s041..s060` to write one stub fragment per
scene. Builders fill them in (`orchestration.md`), and after every 3–5 scenes
they run a small build:

```bash
python -X utf8 <skill>/scripts/assemble.py . --scenes s041..s045 --tag tmp-b3
python -X utf8 <skill>/scripts/validate.py builds/tmp-b3
```

That catches layout, contrast and runtime errors while the context is still
warm, instead of after a whole part. The assembler assembles and validates
each part as `--tag p1 --scenes s001..s040`.

### 12. Render and finish

```bash
cd builds/p1 && npx --yes hyperframes@0.8.77 render -q high -f 30 --strict -o ../../renders/p1-raw.mp4 && cd ../..
python -X utf8 $R/finish.py . --render renders/p1-raw.mp4 --from <part start> --audio builds/p1/assets/audio/mix.m4a -o renders/p1.mp4
python -X utf8 <skill>/scripts/probe.py renders/p1.mp4 --expect 1920x1080 --fps 30 --loudness --black
```

`finish.py` composites the edited webcam as a circular PiP (`--ring HEX`
draws a ring around it). The skeleton knows the mode from TIMING: in recording
mode it keeps 9:16 captions right of the PiP and drops the signature, whose
corner the PiP takes. The defaults are
the bottom-right for 16:9 and the safe slot in `reframe.md` for 9:16. It copies
the untouched mix, so loudness and true peak survive the render. Get each
part's start from `python <skill>/scripts/tl.py . part p1`. Join the parts with
the ffmpeg concat demuxer (`-c copy`, since every part uses the same encoder
settings) and probe the joined file.

### 13. Shorts

Shorts come after the master is approved. That is the user's decision, so never
skip ahead to them.

```bash
python -X utf8 $R/shorts.py . build            # builds/short-<id>/: 9:16, HUD title, 1.2 s music tail and fade
python -X utf8 $R/shorts.py . render           # one render at a time, then the PiP finish
python -X utf8 $R/shorts.py . probe            # 1080×1920, 30 fps, loudness, blackdetect; "not rendered" when missing
```

Before rendering, run `node <skill>/scripts/check-bounds.mjs builds/short-<id>`.
It steps the timeline every 0.05 s and measures every visible text run against
the 9:16 safe areas. It catches text that leaves the frame mid-animation or an
end drawing that never finishes, which contact sheets miss.

## Keep

- A contact sheet of every scene (`scripts/contact-sheet.py`, ≤ 1400 px wide).
- The ratio-scope audit (`scripts/audit-ratio-scope.py`) before each commit of
  9:16 overrides, so the master never regresses.
- Loudness, ffprobe and blackdetect checks for every ratio.
- Disjoint file ownership: one builder per scene range.
