# Fish Audio Drama 3: voice direction, routes and cost

Read this before you cast a voice on Drama 3, write directed lines, or run a Drama 3 `tts` job.

**Where it stands.** The user listened to Vietnamese lines and judged that Drama 3 acts better than Gemini 3.8 TTS, at a higher cost. That is this project's preference, not a general benchmark. Gemini Flash TTS stays the FRONTIER default (`engines.json` role `tts`). It changes only after the FRONTIER benchmark below and the user's approval.

**Benchmark 2026-10-27** (`plans/reports/benchmark-261027-1700-drama3-vs-gemini-vi.md`). In the user's blind A/B, Gemini won 2 to 1. Drama 3 won only the shout. The uncast Drama 3 voice drifted to a Northern accent, and the take ASR had failed was the one the user preferred. The user decided that **FRONTIER stays on Gemini 3.8** for consistency.

## Two texts per line

Every Drama 3 `tts` job keeps two texts:

| Field | Holds | Read by |
|---|---|---|
| `text` (plain_text) | the spoken words only | subtitles, captions, ASR, forced alignment, `gate-tts-takes.py` |
| `directed_text` | the words plus `[directions]`, paired tags and speaker tags | the TTS request only |

Remove the markup from `directed_text` and you must get `text` back (Unicode NFC, collapsed whitespace). Otherwise the run refuses the job, so a direction can never change the words. `text` itself must not carry markup. The receipt saves `plain_text` with the job, and `align` jobs strip markup before they call the aligner. The code that enforces all of this is `scripts/studio/voice_direction.py`.

## Writing a direction

- **Emotion, intent and pacing** go in natural language inside `[]`, placed before the words they colour. Vietnamese directions work, for example `[giọng run run, cố nén nước mắt]` or `[lạnh lùng, dứt khoát]`. Write what the character wants, not adjective lists: `[cố tỏ ra bình tĩnh nhưng sắp vỡ òa]`.
- **Pauses, laughter and breath** are directions too: `[ngừng một nhịp]`, `[cười khẽ]`, `[hít một hơi]`. Punctuation such as `...` and `—` also changes timing. Do not invent words like "haha" just to get a laugh, because they end up in the subtitles.
- **Paired tags** wrap a span: `<whisper>`, `<emphasis>`, `<soft>`, `<fast>`, `<slow>`, `<stress>`, `<forceful>`. Tags must be balanced, nested properly and never open twice. Any other `<tag>` is refused.
- **One line per job** by default, so each line can be retaken on its own. `<|speaker:N|>` turns (multi-speaker dialogue in one request) are refused in a normal job. Use them only in a deliberate multi-speaker job, and only on a transport that supports them: native Fish (`--turns-file`, one `--voice` per speaker) or OpenRouter `--turns-file`. Check the transport on a free dry run first.

Example (`assets/templates/voice-direction.example.json`):

```json
{"id": "sc03-01", "speaker": "zuey", "text": "Anh... đừng đi.",
 "directed_text": "[giọng run run, cố nén nước mắt] Anh... <whisper>đừng đi.</whisper>"}
```

## Vietnamese, code-switching and pronunciation

- Write proper Vietnamese with full diacritics. Spell numbers, dates and units the way they should be read when it matters, for example `hai nghìn không trăm hai mươi sáu`. On native Fish, `--language vi` sets the normalization hint.
- With code-switching (English product names or tech terms), keep the original spelling and listen to it. If it comes out wrong, fix it with a pronunciation dictionary on native Fish. Do not respell the word in `text`, because subtitles read that field.
- Vietnamese phoneme or IPA control is **not** assumed to work. Use it only after a take proves it.
- Pronunciation dictionaries are pinned by a fixed `version`. `latest` is refused, so a re-render sounds the same.
- **Human review is required** for proper names, dialect words, tones on short one-syllable lines, and any line where the gate's ASR disagrees with `text`. These need the user's ear ("cần tai Duy").

## Routes: OpenRouter and native Fish

| | OpenRouter | Native Fish |
|---|---|---|
| job fields | `provider: openrouter`, `tts_model: fish-audio/drama-3` | `provider: fish`, `tts_model: drama-3` |
| command | `multix openrouter tts --text-file ... --json` | `multix fish tts --text-file ... --json` (multix ≥ 1.22.0-beta) |
| key | `OPENROUTER_API_KEY` | `FISH_API_KEY` in `~/.multix/.env` |
| model confirmation | `model_resolved` from `/generation` | none: Fish does not echo the model (`model_confirmed: false`) |
| cost receipt | `generation_id`, `cost_usd` billed | estimate from bytes; read real spend from the Fish dashboard |
| voice design, cloning, dictionaries | not exposed | `multix fish voice-design`, `fish clone`, dictionaries (see multix #363 for what remains) |

Do not assume the two routes support the same features. A tag, voice or option proven on one route is not proven on the other. A job names its provider and model, and the run refuses a model the provider does not serve. Nothing falls back silently to the other route, to Gemini or to ElevenLabs. Gemini and ElevenLabs jobs and older voice profiles run exactly as before.

## Voice identity vs performance

- **Identity** belongs to the character in the series bible: `bible/characters/<id>.json` → `voice` = `{provider, model, voice_id, approved: true, approved_take, dictionaries}`. It is pinned there and never set per line.
- **Performance** belongs to each line (`directed_text`, optional `instructions` on OpenRouter).
- A job that names a different voice from the approved one is refused unless it has `recast_ok: true`, which needs the user's approval of the recast.
- **Casting** works like this. Shortlist library voices, generate the same 3 to 4 test lines per candidate (one calm, one angry, one whisper, one with a name), then let the user pick by ear. Pin the `voice_id` and the approved take path.
- **Voice Design and Voice Cloning** (native Fish only) are an optional G1 step. A clone needs the voice owner's consent and rights (`consent.rights_confirmed`, owner, evidence). A designed or cloned voice also needs `approved_by` before any line uses it. `anime-studio.py voice-direction` refuses the manifest otherwise.

## Manifest

`anime-studio.py voice-direction <manifest.json>` checks every character and line: pinned voices, consent, dictionary versions, tags, and plain-text round trips. `--emit-jobs <episode>` adds one planned `tts` job per line to that episode's `gen-plan.json`. Jobs already in the plan are left alone.

## Cost, receipts and safety

- **Billed by UTF-8 bytes of everything sent**, directions and tags included. Vietnamese letters with diacritics take 2 to 3 bytes each. The runner sets `units` to the byte count of `directed_text`.
- Prices come from `price-table.json`, with a source, a `checked` date and dated `windows`. OpenRouter (`openrouter/fish-audio/drama-3`) and native Fish (`fish/drama-3`) have **separate** prices. Never reuse one route's price for the other.
- If no price window covers today (a promotion ended and nobody re-checked), the job is **refused**. Re-check the source, update the table, then run it.
- G0/G1, the episode ceiling (`--allow-over`) and the one-probe rule for an unmeasured price all apply as they do for other jobs.
- **No duplicate paid requests.** The job is saved with `request_sent: true` before the call. A job that failed after that point may have been billed, so `--retry` refuses it until you check the provider's usage and pass `--paid-retry-ok`.
- **Receipt** fields: `model_requested`, `model_resolved`, `model_confirmed`, `upstream_provider`, `generation_id`, `voice_id`, `plain_text`, `utf8_bytes`, `audio_sha256`, `estimated_cost_usd`, `cost_usd`, and `cost_basis` (`billed` or `estimate`).
- **Retakes never overwrite.** When the target file exists, the take goes to `name.r2.mp3`, `name.r3.mp3`… and is listed in `revisions`. The approved take stays where the bible points.

## FRONTIER benchmark (before any default change)

Run the same Vietnamese lines on Drama 3 and Gemini 3.8 TTS, on the same characters and scenes. Each run costs money, so get the user's approval of the line list and ceiling first. Measure:

- voice consistency across scenes;
- emotion and acting fidelity, and Vietnamese pronunciation;
- accuracy of the spoken words (gate ASR against `text`);
- timing, lip-sync and fit with the picture;
- acceptance rate and number of retakes;
- cost per accepted second;
- the user's blind A/B preference (shuffled file names).

Write the results to a benchmark report. Change `engines.json` `tts.default` only with those results and the user's approval.
