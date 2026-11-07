# Text-to-Speech Guide

Synthesis reference: model choice, voice settings, pauses, pronunciation,
stitching, dialogue, and streaming. Write and direct the script first with
`references/scriptwriting-and-performance-guide.md`; this file covers sending a
finished script to the provider.

Model IDs, settings, and limits below reflect provider documentation at the time
of writing. Verify live availability on the account (`GET /v1/models` or the
[models page](https://elevenlabs.io/docs/overview/models)) before generating, and
do not quote prices or character limits as current without checking.

## Choose the Model by Use Case

| Use case | Prefer | Notes |
|----------|--------|-------|
| Expressive or acted voiceover, audiobooks, character work, dialogue files | `eleven_v4` | Provider-recommended default for expressive TTS; audio tags; HTTP and Text to Dialogue |
| Expressive realtime dialogue, agents, interactive characters | `eleven_v4_turbo` | Low latency; served over the Text to Dialogue WebSocket, not the HTTP TTS endpoint |
| Very long-form stable narration | `eleven_multilingual_v2` | Previous generation; documented as most stable on long-form; no audio tags, no `language_code` |
| Lowest latency or high-volume batch | `eleven_flash_v2_5` (multilingual), `eleven_flash_v2` (English) | Some voice settings are ignored for speed; `stream-input` WebSocket |
| Existing v3 projects | `eleven_v3` | Previous expressive generation; the provider recommends testing v4 |

`eleven_turbo_v2_5` / `eleven_turbo_v2` are documented as superseded by the Flash
models. Choose from the listener's need (quality, latency, length, language),
then confirm the model exists on the account.

## Voice Settings by Model Family

| Setting | Range | v4 / v4 Turbo | v3, v2, Flash |
|---------|-------|---------------|---------------|
| `stability` | 0-1 | yes | yes |
| `similarity_boost` | 0-1 | yes | yes |
| `style` | 0-1 | **no** | yes |
| `speed` | multiplier | **no** | yes |
| `use_speaker_boost` | bool | **no** | yes |

- Lower stability = wider emotional range, less predictable; higher = steady.
- Higher similarity = closer to the source voice, but can amplify artifacts.
- On v4, direct pace and emotion in the text (audio tags, punctuation,
  structure) instead of `style`/`speed`. Never send unsupported settings; the
  bundled generator refuses them with a usage error.
- Omit settings you have no reason to change so the voice's stored settings apply.

Starting points (adjust from listening, not from these numbers): narration
stability ~0.7, conversational ~0.4, character/drama ~0.3.

## Pauses and Pacing by Model Family

| Model family | Use | Do not use |
|--------------|-----|------------|
| Eleven v4, v4 Turbo, v3 | Audio tags (`[pause]`, `[long pause]`, `[exhales]`), ellipses `...`, dashes `-` / `—`, line and paragraph breaks, sentence length | SSML `<break>` tags (unsupported) |
| Multilingual v2, Flash v2.5 / v2 | `<break time="1.5s" />` (up to 3 s), plus punctuation | Audio tags as reliable control; many breaks in one request (can cause speed-ups or artifacts) |

Punctuation is performance control on every model: ellipses add weight or
hesitation, dashes cut or interrupt, CAPITALS add emphasis, question and
exclamation marks shape intonation. Results vary by voice; audition key lines.

## Audio Tags (v4, v4 Turbo, v3)

Audio tags are natural-language directions in square brackets, not a fixed
enum. Place a tag immediately before (or after) the segment it should affect.

- Delivery and emotion: `[whispers]`, `[sarcastic]`, `[curious]`, `[excited]`,
  `[crying]`, `[low, gravelly voice]`, `[quietly, with controlled fear]`.
- Human reactions: `[laughs]`, `[sighs]`, `[exhales]`, `[clears throat]`, `[gulps]`.
- Audio events and overall direction exist (`[applause]`, `[auctioneer]`) but a
  sound-like tag can be read as a sound effect instead of a delivery note; write
  voice-quality tags descriptively when you mean the voice.
- Experimental tags (`[strong French accent]`, `[sings]`) vary by voice; mark
  them as risky in production notes.
- Tags land most reliably when the delivery exists in the voice's training data;
  match tags to the voice (a calm narrator voice may not shout convincingly).
- Visual stage directions (`[smiles]`, `[walks away]`, `[standing]`) are not
  auditory and must stay out of the spoken payload.

## Pronunciation

- **Eleven v4**: IPA wrapped in forward slashes inside the text, e.g.
  `/ˈæktʃuəli/`. Test important names with the chosen voice.
- **SSML phoneme tags** (`<phoneme alphabet="ipa" ph="...">word</phoneme>` or
  CMU Arpabet with stress markers): documented only for `eleven_flash_v2`.
- **Other models**: spell phonetically, or use a pronunciation dictionary with
  alias rules (`pronunciation_dictionary_locators`, up to 3 per request).

## Text Normalization and Language

- `apply_text_normalization`: `auto` (default), `on`, `off`. Expand numbers,
  dates, currencies, phone numbers, URLs and abbreviations in the script when
  delivery matters (`$50` -> `fifty dollars`). Flash models may skip
  normalization by default for latency.
- `language_code` (ISO 639-1, e.g. `fr`) enforces language and normalization on
  models that support it; unsupported codes are ignored; not accepted on
  `eleven_multilingual_v2`.
- v4 generates fluent target-language speech even when the voice's source
  language differs; the source accent is not carried across languages. Test if
  the brief depends on a carried accent.

## Long-Form and Request Stitching

Split long scripts at paragraph or scene boundaries, keep the same voice,
model, and settings, and give each request its neighbors:

- `previous_text` / `next_text`: the text spoken just before/after the chunk.
- `previous_request_ids` / `next_request_ids` (up to 3): request IDs of adjacent
  generations; when present they take precedence over the text fields. Useful
  when regenerating one middle chunk.
- Provider docs state request stitching is not available on `eleven_v3`; use
  `eleven_v4` for stitched long-form, or split v3 scripts at clean scene breaks.

```bash
python scripts/elevenlabs-text-to-speech-generator.py -f part-02.txt -m eleven_v4 \
  --previous-text "...last sentence of part one." --next-text "First sentence of part three..." \
  -o part-02.mp3
```

Listen across every seam for pops, tone shifts, or unnatural pauses.

## Multi-Speaker: Text to Dialogue

For multi-speaker files on v4 or v3, use the Text to Dialogue API rather than
stitching single-voice clips:

```python
from elevenlabs import ElevenLabs

client = ElevenLabs()
audio = client.text_to_dialogue.convert(
    model_id="eleven_v4",
    inputs=[
        {"text": "[cautiously] Hello, is this seat-", "voice_id": "VOICE_ID_A"},
        {"text": "[jumping in] Free? [cheerfully] Yes it is.", "voice_id": "VOICE_ID_B"},
    ],
)
with open("dialogue.mp3", "wb") as f:
    for chunk in audio:
        f.write(chunk)
```

- Each turn has its own `voice_id`; tags go inside that turn's text.
- Documented guidance: keep the total of all `inputs[].text` around 2,000
  characters per request; split longer scenes. Verify current limits.
- Settings are `stability` and `similarity`; `language_code`, `seed`, and
  continuity fields exist but are not supported by every model.
- Expect to generate several takes and pick the best.

The bundled generator is single-voice HTTP TTS; it does not call Text to Dialogue.

## Streaming and Realtime

- HTTP streaming (`client.text_to_speech.stream(...)`, or the generator's
  `--stream`) lowers time-to-first-byte for v4, v3, v2, and Flash.
- `eleven_v4_turbo` streams over the Text to Dialogue WebSocket
  (`/v1/text-to-dialogue/stream-input`); set `new_turn` when a speaker finishes.
  It is an application integration, not a file-generation CLI path.
- `eleven_flash_v2_5` / `eleven_flash_v2` support the `stream-input` TTS WebSocket.
- v4 is documented as not available on the `stream-input` TTS WebSocket.

## Output Formats

Common values: `mp3_44100_128` (default), `mp3_44100_192`, `pcm_16000`,
`pcm_24000`, `pcm_44100`, `ulaw_8000` (telephony), `opus_48000_64`,
`wav_44100`. Higher-quality formats can require a paid tier; check the account.

## Python Example (v4)

```python
from elevenlabs import ElevenLabs, VoiceSettings

client = ElevenLabs()  # reads ELEVENLABS_API_KEY
audio = client.text_to_speech.convert(
    voice_id="JBFqnCBsd6RMkjVDRZzb",
    model_id="eleven_v4",
    text="[warmly] Welcome back... [excited] and this time, it's BIGGER.",
    voice_settings=VoiceSettings(stability=0.45, similarity_boost=0.75),
)
with open("output.mp3", "wb") as f:
    for chunk in audio:
        f.write(chunk)
```

For `eleven_multilingual_v2` or Flash you may add `style`, `speed`, and `<break>`
tags; for v4 and v3 you may not use `<break>`.

## Common Errors

- **401**: invalid API key. **422**: invalid parameters (voice, model, or a
  setting the model rejects). **429**: rate limit; back off and retry.
- An unavailable model or failed call is reported as a limitation, never as a
  generated file.
