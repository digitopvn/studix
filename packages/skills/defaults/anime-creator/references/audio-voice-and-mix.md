# Sound design, voice and the mix

Sound sells weight and emotion more cheaply than pixels: a 0.8s clash SFX costs a few credits and makes an
average shot land. The mix is deterministic code, so changing one scene's cut never shifts another scene's
sound.

## Buses and layers

| Bus | Content | Typical level |
|---|---|---|
| beds | ambience (wind in the garden, city hum), room tone, foley loops | low, ducked under dialogue |
| hits | whooshes, clashes, impacts, cloth, landings, shimmers | loud and short, own compressor/limiter |
| vo | dialogue from Omni clips or TTS | +4 dB trim over the rest in measured mixes |
| music | score from a composition plan | -2 dB trim, ducked under dialogue and big hits |

## Spotting sheet (before generating)

For each shot list what the audience must hear: the hit on the contact frame (from `hits` and the FX cues),
the whoosh 2-4 frames before a strike, cloth on a catch, feet on a landing, a shimmer on the title. A fight
of 15s used 13 SFX. Weight comes from layering: a landing is a low thump + material (wood, tile) + cloth,
not one sample; a single soft "branch-land" was one of the four defects left in a v1.

Action scenes: spot against the measured reference numbers in `action-sound-from-references.md` (hits on
the contact frame, low end, density, rare suck-outs, music share and ducking).

## SFX (ElevenLabs via `multix elevenlabs sfx`)

Job kind `sfx`: `text`, `duration` (seconds), `prompt_influence` (0.5-0.7 kept results literal), `out`.
Describe the source, the distance and the space ("single fast silk sleeve and sword swish, close, dry").
Generate two variants for the key hits and pick by ear and by `anime-studio.py onsets`. ElevenLabs allows 5
concurrent requests; the runner defaults to 4 (`--concurrency`), more returned HTTP 429. On a busy account 4
also returned 429 (FRONTIER ep03); drop to 2 before retrying.

- **Time hits from the picture's event frames.** Find the frame where the event happens on the plate
  (contact, flash, the light going out) and place the transient there. Times read off the editor's notes
  were 8-12 frames off.
- **Every visible change of state gets a cue**, not only hits: lights popping, power down, a collapse,
  debris raining, a magic effect. Cut 1 of ep03 drew notes on each one that was silent.
- **Reaction vocals.** Gemini TTS laughs came out as giggles; an ElevenLabs belly laugh worked. Generate
  non-verbal reactions (laughs, gasps, sighs) as their own takes and gate them with the non-verbal settings
  in `voice-takes-and-stylized-voices.md`.

## Foley from the picture (video-to-audio)

A `sfx` job with `mode: "video-to-audio"` routes through role `sound-generation` in engines.json
(`studio/sound_generation_adapters.py`). Text-only SFX keep the ElevenLabs default; V2A walks `order`
(`hunyuan-foley-fal`, then `mmaudio-v2-fal`) unless the job names `engine` or `model`.

- Input: `clip` (+ `in`, `duration`), `prompt`, optional `negative_prompt`, `seed`. The clip must be an https
  URL or small enough for a data URI (`data_uri_max_bytes`); anything else is refused until multix can
  upload files (multix-cli#284). The fal key lives in `~/.multix/.env`, never in the plan. multix 1.12.x reads
  `FALAI_KEY`; newer builds read `FAL_KEY`. When `multix fal run` reports no key, export `FAL_KEY` from
  `FALAI_KEY` for the process instead of editing the file.
- Licence: `episode.json` `license_policy` `{use: commercial, allow_unknown_license}`; an adapter whose
  licence does not match is refused. The fal endpoints are listed commercial; the open weights are not.
- Output: `audio/sfx/<scene>/<id>.wav` (48 kHz, 24-bit), a `.wav.json` sidecar (clip sha256, in, speed,
  request id, model) and a proposal `work/v2a/mix-add-<id>.json` on the hits or beds bus only. Merge it
  with `merge-mix-proposals.py`. An existing output is never overwritten; a timed-out request resumes with
  `--retry` from its request id instead of paying twice.
- `anime-studio.py v2a-stale <ep>` lists stems whose clip bytes, in-point or speed changed since generation.
- Measured on 21 s of clips (2026-10-26, fal balance delta): MMAudio $0.001/s, 20-36 s per job; Hunyuan Foley
  $0.00996/s billed per real second (no 10 s minimum), 20-150 s per job. In the ear review of five ep01
  clips Hunyuan won all five, including two where onset metrics favoured MMAudio, so it leads `order`.
  Both are weak on dense small Foley (typing): place ElevenLabs SFX by hand there.
- **Native audio from the video model can win.** On ep03's Seedance action shots the user picked the clip's
  own SFX over Hunyuan by ear; the native onsets were also closer to the picture events (260 against 563 ms,
  469 against 2049 ms, 494 against 1177 ms). Keep the native track as a candidate on any clip that has one and
  A/B it, level-matched, before buying V2A.
- **V2A invents speech** on shots with faces. Transcribe every V2A stem (role `asr`) and reject one that holds
  words; add "no speech, no voices" to the prompt.
- **Content filter.** fal refused prompts with weapon words; describe the sound ("sharp metallic impact,
  short ring") instead of the object.
- **1 s floor.** Hunyuan refuses clips under 1 s; pad the input range and trim the stem.
- **Low end and DC.** Some stems carried DC offset and energy under 30 Hz; high-pass V2A stems at about 30 Hz
  on ingest and treat a measurable DC offset as a failed check.

Stem separation (role `audio-separation`): `elevenlabs-isolate` for dialogue cleanup; `demucs-local` is
listed but untested.

## Music (composition plan)

Job kind `music` with `plan` = `audio/mus/plan.json` (template `music-plan.example.json`): global positive and
negative styles, then sections whose lengths follow the beats. Each section must be at least 3000 ms or the
API answers HTTP 422; sum the sections to the film length (merge short beats). Ask for no vocals under
dialogue. Atlas music models (minimax, suno) are cheaper per call but untested for timing control.
Write the plan from the episode's beats; never submit the template's sample sections, which once reached a
paid job. End each cue on a musical phrase, not on a fade at the cut.

## Voice: choosing the source

| Source | When | Watch out for |
|---|---|---|
| Omni native speech (keep clip audio, `audio: true`) | the character speaks on screen (measured in zh and ja) | misread characters (天 read as "ten"): transcribe with seed-asr and compare to the script; timbre drifts between clips |
| ElevenLabs TTS `eleven_v3` (job kind `tts`) | off-screen lines, narration, Vietnamese, a line Omni got wrong | lip-sync: keep the mouth hidden or off screen, or accept a lip-sync model (untested); use `--language-code`, try 3 seeds and keep the best |
| voice-changer to the bible voice | Omni performance is right but the voice must match the series | pass `--remove-background-noise`; costs credits per second |
| isolate | Omni audio carries music or ambience under the voice | input must be at least 5s: pad short clips with silence first (`input_padded`) |

Audio tags like `[playful]` or `[whisper]` at the start of a TTS line steer `eleven_v3` delivery. Store the
chosen `voice_id` and seed in the character file.

### Gemini Flash TTS (the FRONTIER series voice)

FRONTIER voices every character on `gemini-3.8-flash-tts`. The user chose it by ear over an `eleven_v3`
clone that the Gemini judge had ranked first.

- **Prompt.** The transcript carries inline tags (`<sigh>`, `<laugh>`, `<whisper>`), and the style is one
  sentence that names the beat's emotion. End the prompt with a guard: "say exactly this text, add nothing".
  Without it the model added words.
- **Takes.** Generate at least 6 takes per line, at about $0.001 a call (billed $0.0009 on ep03, not the
  $0.005 once assumed). Transcribe every take and diff it
  against the script (the ASR diff); a take with an added, dropped or misread word is out before anyone
  listens.
- **Ranking.** Rank comparatively. Put the surviving takes in one reel that opens with an approved anchor
  line of the same character, and judge them together, not one file at a time. The anchor keeps the accent
  honest: a Southern (Saigon) character slipped into a Northern accent in some takes.
- **The user's ear is final.** The user chose this voice over an `eleven_v3` clone that the Gemini judge had
  ranked first. When a judge and the user could disagree (a voice choice, an accent), send an A/B reel. Do
  not recast because a judge said so.
- **Respellings.** Names the model mispronounces go in a respelling map in the character file
  (`voice.respellings`, for example "Claude" to "Clâu"), applied before synthesis. Do not fix them in the edit.
- **Picks.** Normalize the chosen takes to -18 LUFS with a true peak of -2 dBTP or lower.
- **Fit.** When the best take is longer than its slot, retime the edit to the take, or retime the take with
  `retime-vo-line.py` (below). Do not pick a worse take because it fits.

Gating takes from any provider and stylized voices (robots, radios): `voice-takes-and-stylized-voices.md`.

### Fish Audio Drama 3 (candidate)

Drama 3 acts Vietnamese lines better than Gemini by the user's ear, at a higher cost. It is a candidate, not the default, until the FRONTIER benchmark is done and the user approves. Directions, tags, routes (OpenRouter or native Fish), byte pricing and retake rules are in `references/fish-drama3-voice-direction.md`.

### Dialogue on screen: Omni lip-sync, then replace the voice

When a character speaks on screen, the cheapest convincing route is Omni for the acting and the mouth,
plus the series TTS voice laid over it:

1. Generate the shot on Omni with the line in the prompt, so the mouth moves on the right syllables.
2. Transcribe Omni's audio (Scribe json) to get its word onsets. Align on STT words, not on an energy VAD,
   which hears thunder and breaths as speech. When Omni only shouts and STT returns no words, the VAD is
   the fallback.
3. Lay the chosen take onto those segments:

   ```bash
   uv run --with numpy python -X utf8 scripts/align-vo-to-omni.py gen/video/s07.mp4 audio/vo/s07-l1-al.wav \
     audio/vo/s07-l1-t*.wav --omni-words work/stt/s07.json --window 0.4,4.9 --close-gaps 0.12 --keep-tail 0.8 \
     --json work/align/s07.json
   ```

   It picks the take that needs the least stretching (clamped to 0.85-1.15x). The gate is
   `within_3_frames`: every phrase ends within 3 frames of Omni's.
4. Place it: `head = max(0, in / speed - start)`; trim `head` seconds off the front of the wav and set the
   line's `t0 = shot start + start + head - in / speed`. Never clamp a negative `t0` to 0, which shifts every
   word late.
5. Cut dialogue with L-cuts: the next shot's picture comes in under the line's tail. Mark such a line
   `"grow": false` (FRONTIER's scene assembler honours it) so it runs on over the cut instead of holding its
   shot open.

### Retiming a line without a new take

`retime-vo-line.py` re-cuts an aligned take: keep spans at their own tempo, insert pauses (silence or the
take's own room tone), and carry the word timings, so no new paid take or alignment is needed:

```bash
python -X utf8 scripts/retime-vo-line.py audio/vo/l12.wav audio/vo/l12-r2.wav \
  '[[0, 1.42, 1.0], ["gap", 0.25, 1.42, 1.6], [1.6, 3.1, 0.92]]' --edl scenes/sc02/edl.json --line l12
```

Put span edges in pauses between words. Tempos under 0.5 chain `atempo` stages. Anything under 0.85x is
flagged for the user's ear. With `--edl` and `--line`, the line's `vo` and `words[].t0` move with the cut
(base = `t0 + vo_offset`, atomic write); `t0` and `t1` stay put, so move `t1` when the line got longer.

### Optional performance-first route

For an emotional scene where TTS reads flat, a recorded human performance can lead: record the line, clean
it (`audio-separation`), convert it to the series voice, then force-align it like any take. Run it as an A/B
against the TTS take on that scene only and let the user pick by ear; TTS stays the default route. This
route has no measured result yet.

## Forced alignment and captions

An `align` job (input audio + exact text) returns word timings; with `scene`, `shot` and `line` set, the
runner writes them into that EDL dialogue line, and the captions get a karaoke highlight per word. Run it on
the final VO take only.

## The mixer (`scripts/build-audio-mix.py`)

```bash
uv run --with numpy python scripts/build-audio-mix.py <episode-dir> [--scene sc01] [--peaks]
```

Reads `audio/mix-events.json` (template `mix-events.example.json`):

- Times: `scene` + `t` (scene time), `scene` + `at_shot` + `t` (from that shot's start), or no scene
  (episode time, for music across scenes).
- Per event: `file`, `gain`, `bus`, `fx` (preset name or raw ffmpeg chain), `pan`, fades, `len`.
- Presets: `air`, `hit`, `far`, `radio`; `bus_fx` for the hits bus compressor/limiter.
- `auto`: every video shot with `audio: true` contributes its conformed wav; every dialogue line with a
  `vo` file is placed at its `t0` (`vo_offset`, `vo_gain` and `vo_fx` on the line shift, trim and process
  it; `vo_fx` takes a preset name or a raw chain, e.g. a long echo for a giant or `radio` for a drone).
- `duck` windows by hand plus `duck_from_dialogue` (music 0.75, beds 0.6 of level under each line). The user
  must still hear the song under the voices: 0.45 plus hand ducks read as "too quiet, I can't hear anything"
  on FRONTIER ep03. Hand windows multiply on top of it, so keep them at 0.5 or above under dialogue. Where a
  voice is masked, carve the music (EQ, a dip in that stem's own volume) instead of pulling the whole bus.
  `duck_from_dialogue_override` applies per line that starts inside its window, not per time window.
- `bus` must be one of `beds`, `hits`, `vo`, `music`. A misspelt bus name is not rejected yet, so the event
  silently drops out of the gates; `qa-prescan.py events` flags it.
- Shared acoustics, so a scene's effects sit in one space instead of reading dry and pasted on:
  - make an IR per location: `uv run --with numpy python scripts/make-space-ir.py audio/ir/street.wav --preset
    street` (presets `street`, `plaza`, `hall`, `room`, `server`; `--rt60`, `--seed`);
  - declare it: `"spaces": {"street": {"ir": "audio/ir/street.wav", "return_db": 0}}`;
  - send a scene to it: `"scene_space": {"sc03": {"space": "street", "send_db": {"beds": -12, "hits": -10}}}`;
  - an event may override with its own `space` or `send` (dB relative to its dry gain; `-5` for distant
    events). The wet return joins its bus before ducking, so a duck also dips the tail.
- Output `audio/mix.wav`, 48 kHz 24-bit, exactly the edit length: one static gain to -14 LUFS, then a
  4x-oversampled limiter at the true-peak ceiling (-1.5 dBTP by default), re-run until both hold. Not loudnorm:
  with `linear=true` it silently falls back to its dynamic mode whenever the gain would cross the ceiling (every
  action premix does), and the dynamic mode rode each scene's head up to +3.6 dB hot.

Measure before changing gains: `--peaks` prints per-bus peaks every 0.25s. A first premix hit +6.7 dBTP and
the limiter was carrying 5 dB, squashing a shout; the fix was bass punch on hits (`bass=g=5:f=70`), a looser
hits compressor, music +3 dB and extra duck windows, not a harder limiter. A tighter limiter attempt once
collapsed the mix RMS from -4 to -14.

The mix WAV is the only audio source of every delivered file. Each encode takes it once, behind an oversampled
limiter (`finish-scenes.py`, `assemble-episode.py`; see `grade-master-and-qa.md`). Never re-encode an AAC
track.

## Environment beds (the lesson of FRONTIER EP01 cut 2 and cut 3)

On cut 2, the user's verdict on the sound was that it did not convey the environment of each scene ("chưa thể
hiện được môi trường trong các phân cảnh"). The measurements behind it:

- The beds sat 10-15 dB under the music.
- Some shots had no bed at all.
- In sc03, the share of time where the bed could be heard was 3-41%.

Cut 3 fixed all of those numbers, passed both QA agents, and still failed his ear on the rainy war-zone scene.
Treat the numbers as the floor, not the finish line.

- **Layers per location.** Use at least three bed layers per location (air or room tone, a mid layer of the
  place, a distant layer of the story's world), plus spot effects tied to the picture. Each location gets
  its own perspective. An interior hears the war through glass, so low-pass it and pull it back. A close-up
  pulls the bed back from the wide shot, so the ambience is not static across shot sizes.
- **Source levels.** Normalize each bed file to a working level before placing it. One designer placed a
  -46 dBFS file at +16 dB gain, which also lifted its noise floor. Fix the file, not the gain.
- **Loops.** Loop with a crossfade of 0.5 s or more and stagger the restarts of the layers. A hard restart
  every 20 s is audible.
- **Placement.** Place SFX by the transient, not by the file start: `t = target − onset`, where `onset` is
  the attack inside the file from `anime-studio.py onsets`. A file with a slow lead-in, placed at its start,
  lands late: QA measured hits 0.55 s and 21 frames behind the picture. Record the measured value on the
  event as `"onset": <s>`, so `qa-prescan.py events` can check it; mark a swell or tail that should creep in
  with `"onset": null`. The target of a hit is the plate's own event frame (the explosion, the landing) in
  edit time, `(event_src - in) / speed` from the shot start, not the EDL beat. Align the layers of a composite
  by their transients too, never by file start. Measure the onset on the file's envelope, not by its name: on
  FRONTIER EP03 a landing slam had its body 0.15 s in and a lens crack 0.47 s in, so both hits ran 4 and 8
  frames late with `onset` 0.02; skip the lead-in with `offset`.
- **Source material.** AI-generated rain, crowds and gunfire sound generic. When the user rejects an
  environment twice, ask for a 30-60 s reference clip with the target sound, and switch the beds to real
  recordings (below).

### Real recordings instead of AI beds

FRONTIER sc03 r4 replaced the AI war-zone beds with field recordings. The worked example is
`<episode>/work/cut3/sfx-r4/build_sc03_real_beds.py`; adapt its approach, do not copy its numbers.

1. **Library.** Sonniss GDC bundles, mirrored on archive.org (one item per year), are royalty-free and
   cleared for commercial use, but their licence forbids AI/ML training. Write the licence and every source
   path into `audio/sfx/real/sources.json`.
2. **Pick, do not hoard.** The full set is about 127 GB. Index it once (a `build_index.py` over the
   archive.org metadata), write a pick list of name substrings per scene (`tools/picks-sc03.txt`), and fetch
   only those: `python download.py <library-dir> --list picks-sc03.txt` (resumable; `--only-priority` takes
   regex categories such as rain, fire, battle, debris). Keep it in a library directory outside the project,
   for example `<workspace>/sfx-library`.
3. **Level each source by loudness, then cap it.**
   - The starting gain is `target LUFS - measured LUFS` of the span you use.
   - A mono file is doubled into both channels, so subtract 3 dB more.
   - LUFS-matching a transient one-shot (artillery, debris) gives it huge peaks. Cap each category's dry peak:
     `gain = min(gain, CAP[category] - peak)`. FRONTIER used -11 dBFS for close spots, -20 for distant, -18
     for far booms.
   - Continuous field recordings (rain, fire crackle) carry pops far above their body. Trim them about 5 dB
     and put an `alimiter` in the event's `fx`, with the limit set so the bed never peaks over about -14 dBFS
     after its gain.
4. **Distance.** Distant events get a bandpass preset (`highpass=f=110,lowpass=f=2600`, or 45-1800 Hz for far
   booms) and a wetter reverb send (`"send": -5`) than the scene default.
5. **Weight and order.** Put a debris tail (rubble, glass, sand, 1.5-3 s, never cut short) after every big
   impact. Pull the hits down a few dB once the beds are real, thin repeated hits on their later uses, and
   duck the score under the heaviest hits.
6. **Compare with the reference, then listen.** `mix-shape-features.py ref.wav@60-120 ours.mp4@0-58`
   prints the bed floor (p10-p50), peak rise (p90-p50), band shares, onsets per second and stereo width for
   both. The numbers show where ours differs; they are evidence, not the judge. The user's ear decides.

## Parallel sound designers and proposals

One designer per scene (a Sonnet subagent with the EDL, the brief and the gate numbers) is the cheapest way
to cover an episode. Cut 3 used five designers, merged 650 events and had zero conflicts.

- Designers never edit `audio/mix-events.json`. Each one writes `work/<round>/mix-add-<scene>.json` (template
  `assets/templates/mix-add.example.json`, with `remove`, `modify`, `add` and `duck`) and checks its own
  scene with `audit-mix-buses.py <ep> <scene> --events <a copy with the proposal merged>`.
- The controller merges all of them at once:

  ```bash
  python -X utf8 scripts/merge-mix-proposals.py <ep> work/cut3/mix-add-sc0*.json --backup-label cut2-final
  ```

  Every `match` must hit exactly one event, or nothing is written. The first merge keeps a backup that is
  never overwritten. A lock holding the merger's PID stops a second writer; a dead merger's lock is
  reclaimed. Parallel writers once corrupted a shared `edl.json`
  ("Extra data" JSON, WinError 32).
- Give designers the sound rubric from the user's verbatim feedback and the gate numbers below. Then verify
  their claims yourself with the audit, not from their summaries.

### Retiming SFX after a retake

A retake or a new trim moves a shot's in-point, and every sound placed against the old footage moves with
it. On FRONTIER ep02 the gear cues of one shot were still timed for its old take, which started 2.25 s
into the source; QA heard a stray rustle until they were rebalanced, removed or replaced for the new take.

- After any retake or change of `in`, list the events with `at_shot` equal to that shot, and shift each by
  the in-point delta (or re-spot it on the new take's own event frame) in a `modify` proposal; merge it with
  `merge-mix-proposals.py`, never by hand-editing `mix-events.json`.
- Then run `qa-prescan.py events` on the scene to confirm each transient sits on its frame.

## Dubbing an approved cut into another language

A dub is a new language for the whole soundtrack, not only the voices. Work on new copies (`mix-events-<lang>.json`,
tags `{sc}-<lang>-rN`); the approved cut's files stay as they are.
- Song: every OST cue (scene underscore, ending card, recap) uses the series' version of the song in the target
  language (`<series>/ost/ost.json`). A dub that kept the source-language song was rejected on FRONTIER ep03.
  Only wordless instrumentals carry over unchanged. No target version yet is a question for the user, not a reuse.
- Map cues by function and energy, not by lyric alone: for each source cue pick the target-song window of the
  same section, conform it to the source beat grid (stretch factor recorded) so cuts and hits still land, and
  re-time any hand volume holes to the new transients. Under dialogue a sung line is optional; the beat is not.
- Gate the beat drive before QA: per cue region, measure beat-lag periodicity of spectral flux on the music bus,
  dub against source; each region lands within about 20%, or the report says why (a tender beat may sit lower).
  Two QA rounds failed on regions at 0.05-0.19 against 0.33-0.56. A section without pulse gets a driven
  section's drum or no_vocals stem layered under it, bar-aligned; gain alone does not count (contour cap +-3 dB).
- Voices: one voice per character across episodes; each line ends before the cut its source line ended before
  (tempo up to 1.12, else a shorter line and a new take); captions put the target language on top, the source
  below; recap karaoke takes its onsets from the target vocals stem.
- On-screen text (title cards, signs, UI, end card) is part of the dub when it carries words. Keep the swaps in a
  per-language override file applied to a fresh copy of the scene source, never to the source scene. A target
  string is often longer: a no-wrap title sized for the source overflowed the frame in the English cut. After
  each swap, render the frame where the text is largest and check it sits inside title-safe (about 5% margin);
  fix it by splitting it into a kicker and a title line or by stepping the size down, not by letting it clip.
- Remux on the approved picture when only the audio changed; re-render only the scenes whose screen text changed.
Reference build: FRONTIER `ep03/work/en/` (`ost_en_r4.py` for the section map and drum layer, `drive-en-r4.json`
for the per-region numbers).

## Checks

- `anime-studio.py loudness <files>`: integrated LUFS, true peak, LRA; target -14 LUFS / -1.5 dBTP for web.
- `anime-studio.py onsets <vo.wav>`: voice onsets from an RMS envelope. `silencedetect` fails under a
  constant ambience bed.
- `anime-studio.py lipsync <clip> <audio> --crop W:H:X:Y`: mouth motion onsets against voice onsets,
  median lag in seconds. The crop choice changes the answer (a tight mouth crop gave -0.04s; a crop that
  caught moving hair gave -0.33s), so crop tight on the mouth. Lag within 2 frames is in sync.
- Hits line up with the EDL `hits` and the impact frames; listen at the hit with the frame strip open.
- Measure first, claim second: an opening once described as "too loud" measured -24 LUFS momentary. Turn
  a loudness note into a number before acting on it ("2 dB down on the ambience under L04"); a vague "lower
  it" applied to the bed and then to every gate below it cascaded into a mix the user called thin.
- Run `mix-shape-features.py` against a reference on the first premix, not after the user's notes: ep03's
  low bands sat 4.5-6.2 dB under the reference (which sat 1.7-3 dB under its own mids) until a fix round.
- A/B reels for the user's ear are level-matched (about -20 LUFS each) and under 30 MB.
- A mix proposal records the baseline it was measured against (the mix version and the LUFS of the span),
  so the merge can tell when the mix moved under it.
- `measure-reference-cut.py <ref> <ours>@t0-t1`: hit sub share, tail, pre-impact dip and on-cut count against
  chance beside the cut rhythm (see `action-sound-from-references.md`).

### Bed gate, then the ear gate

`audit-mix-buses.py` builds the buses exactly as the mixer does and gates them per shot:

```bash
uv run -q --with numpy python -X utf8 scripts/audit-mix-buses.py <ep> sc01 sc02 [--allow s18] [--json]
```

| Metric | Gate |
|---|---|
| bed exists | > -70 dBFS in every shot |
| mask% (outside dialogue, 100 ms windows where beds >= beds+music+vo - 10 dB) | 60% or more |
| beds - music (outside dialogue) | no more than 6 dB under |
| vo - beds (voiced windows) | +6 dB or more |

`--allow` takes the shots that are silent on purpose, such as a held beat before a title.

- **Then send it to the user's ear.** Passing the gate is necessary, not sufficient.
  - Send a beds-only stem of the scene the user doubts: `--stem beds T0 T1 out.wav`.
  - Send the premix: `--premix-wav out.wav`.
  - Send a share copy. The user approves it.
- **AI sound QA, by role.** An aesthetic scorer (role `audio-aesthetic`) only regression-gates two versions
  of one asset; it cannot judge fit. A multimodal judge (role `ai-judge`, `ai-shot-qa.py`) hears shot groups
  with their beats and lines: on FRONTIER ep02 it found a stray rustle, a stray yell and an unprocessed robot
  line, and called a line cut off that only the clip boundary cut. Verify each finding by ear; `edge` marks
  a clip-boundary finding (`grade-master-and-qa.md`, model review).
- **Gemini is a weak ear.** On sc03 of cut 3 it reported that "a blind listener can immediately tell"
  the rainy war zone, and the user rejected that scene. Its one useful note was that the ambience stayed
  static across wide shots and close-ups. Use Gemini to locate events, not to judge them. Where Gemini and the measurements disagree, mark the item "cần tai Duy" (needs the user's ear) instead
  of deciding it.
- **Audio-only fixes.** Rebuild the mix and remux it under the existing picture with
  `finish-scenes.py --video-from <old tag>`. That takes about a minute; a re-render takes about 17 minutes.
