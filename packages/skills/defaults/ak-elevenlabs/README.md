# ElevenLabs Skill

End-to-end voice production with ElevenLabs: scriptwriting and voice directing,
text-to-speech, multi-speaker dialogue, voice cloning and design, sound effects,
music, and conversational AI agents.

The agent writes and directs the script; ElevenLabs performs it. Writing actions
(`script`, `enhance`, dialogue writing) need no API key.

## Actions

| Action | What it does |
|--------|--------------|
| `script` | Idea or rough copy -> performance-ready script with model-aware audio tags |
| `enhance` | Adds delivery directions to final copy without changing its words |
| `dialogue` | Directs a multi-speaker script; synthesizes via Text to Dialogue |
| `speak` | Synthesizes a finished script |
| `clone` | Clones a voice from consented recordings |
| `sfx` | Generates sound effects or music |

## Installation

```bash
pip install elevenlabs
```

Set your API key in `.env`:
```
ELEVENLABS_API_KEY=your_key_here
```

## Quick Start

```python
from elevenlabs import ElevenLabs, VoiceSettings
client = ElevenLabs(api_key="YOUR_API_KEY")

# Eleven v4: direct delivery with audio tags; only stability/similarity settings
audio = client.text_to_speech.convert(
    voice_id="JBFqnCBsd6RMkjVDRZzb",
    text="[warmly] Hello... [excited] and welcome!",
    model_id="eleven_v4",
    voice_settings=VoiceSettings(stability=0.5, similarity_boost=0.75),
)
```

## Scripts

| Script | Usage |
|--------|-------|
| `elevenlabs-text-to-speech-generator.py` | `python scripts/elevenlabs-text-to-speech-generator.py -f script.txt -m eleven_v4 --stability 0.4 -o out.mp3` |
| `elevenlabs-voice-manager.py` | `python scripts/elevenlabs-voice-manager.py list` |
| `elevenlabs-voice-cloner.py` | `python scripts/elevenlabs-voice-cloner.py "Name" sample.mp3` |
| `elevenlabs-sound-effects-generator.py` | `python scripts/elevenlabs-sound-effects-generator.py "Thunder" -o sfx.mp3` |

The TTS generator is model-aware: it sends only the voice settings the selected
model supports and exits with a usage error for unsupported ones (for example
`--style` or `--speed` on Eleven v4, or SSML `<break>` tags on v4/v3). It also
accepts `--language-code`, `--previous-text` / `--next-text` for stitching long
scripts, and `--text-normalization`.

```bash
# v2-family model with style/speed and a break tag
python scripts/elevenlabs-text-to-speech-generator.py \
  'Ready? <break time="1.0s" /> Go.' -m eleven_multilingual_v2 --style 0.3 --speed 1.05

# Long-form chunk with stitching context
python scripts/elevenlabs-text-to-speech-generator.py -f part-02.txt -m eleven_v4 \
  --previous-text "End of part one." --next-text "Start of part three." -o part-02.mp3
```

Run the generator tests with
`python3 -m unittest discover -s scripts/tests` (no network). See `--help` for
the full flag list.

## Models

Choose by use case and verify live availability on your account; IDs, prices,
and limits change.

| Use case | Model ID | Notes |
|----------|----------|-------|
| Expressive voiceover, audiobooks, dialogue | `eleven_v4` | Audio tags; stability + similarity only; no SSML |
| Expressive realtime dialogue | `eleven_v4_turbo` | Text to Dialogue WebSocket |
| Long-form stable narration | `eleven_multilingual_v2` | Full voice settings; `<break>` tags |
| Lowest latency | `eleven_flash_v2_5` / `eleven_flash_v2` | Realtime and batch |
| Previous expressive generation | `eleven_v3` | Audio tags; no SSML |

## References

- `references/scriptwriting-and-performance-guide.md` - Script, enhance, dialogue direction, examples
- `references/text-to-speech-guide.md` - Models, settings, pauses, stitching, Text to Dialogue
- `references/voice-cloning-guide.md` - Clone voices
- `references/voice-design-prompting-guide.md` - Create voices from prompts
- `references/sound-effects-and-music-generation-guide.md` - SFX & music
- `references/conversational-ai-agents-guide.md` - Voice agents

## Links

- [ElevenLabs Docs](https://elevenlabs.io/docs)
- [Models](https://elevenlabs.io/docs/overview/models)
- [Voice Library](https://elevenlabs.io/voice-library)
