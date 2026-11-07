---
name: ak-elevenlabs
description: "Write, direct and synthesize ElevenLabs voice audio: scripts with model-aware audio tags, word-preserving tag enhancement, multi-speaker dialogue, speech, cloned or designed voices, SFX, music and voice agents."
when_to_use: "Invoke for ElevenLabs voice work; not for video editing or non-ElevenLabs TTS providers."
category: media
keywords: [elevenlabs, speech, voice, tts, voiceover, sound-effects]
argument-hint: "[action: script|enhance|speak|dialogue|clone|sfx] [text-or-file]"
metadata:
  author: agentkit
  version: "1.1.0"
---

# ElevenLabs

End-to-end voice production: the agent writes and directs; ElevenLabs performs.

<args>$ARGUMENTS</args>

## Resolve the Action

Pick the action from the argument or request; infer it when absent (an idea or
outline -> `script`; final copy plus "don't change the words" -> `enhance`;
several speakers -> `dialogue`; a ready script plus "make audio" -> `speak`).

| Action | Outcome | Read |
|--------|---------|------|
| `script` | Idea, outline, article, or rough copy -> performance-ready script | `references/scriptwriting-and-performance-guide.md` |
| `enhance` | Final copy -> same words with delivery directions | `references/scriptwriting-and-performance-guide.md` |
| `dialogue` | Multi-speaker script with per-turn direction, optionally synthesized | scriptwriting guide, then `references/text-to-speech-guide.md` |
| `speak` | Finished script -> audio file | `references/text-to-speech-guide.md` |
| `clone` | Voice clone from consented recordings | `references/voice-cloning-guide.md` |
| `sfx` | Sound effects or music | `references/sound-effects-and-music-generation-guide.md` |

Voice design from a text prompt: `references/voice-design-prompting-guide.md`.
Voice agents: `references/conversational-ai-agents-guide.md`. Read only the
guide the action needs.

## Keep Writing Separate from Synthesis

- `script`, `enhance`, and the writing half of `dialogue` produce text and need
  no API key. Deliver the script; synthesize only when the user wants audio.
- `speak` and dialogue synthesis send a finished script. Do not rewrite wording
  at synthesis time; fix the script first.
- `enhance` preserves every spoken word: strip the added tags and the text must
  match the input apart from punctuation and capitalization.
- Directions must be auditory. Visual stage directions stay in production notes,
  never in the spoken text.

## Output Contract

For `script` and `dialogue`, return the **performance script** (exact text to
send, with tags and performance punctuation) and, when useful, separate
**production notes** (model, voice, risky tags, pronunciation, chunking, lines to
audition). For `enhance`, return only the enhanced script unless analysis is
requested.

## Model Strategy

Choose by use case, then confirm live availability on the account before any
call; model IDs, settings, prices, and limits change.

- Expressive or acted voiceover, audiobooks, dialogue files: prefer `eleven_v4`.
- Expressive realtime dialogue or agents: prefer `eleven_v4_turbo` (WebSocket).
- Very long-form stable narration: consider `eleven_multilingual_v2`.
- Latency-first: Flash variants.

Direction syntax follows the model: v4/v3 use audio tags, punctuation, and text
structure, never SSML `<break>` tags; v2/Flash may use `<break>` where
supported. v4 accepts only stability and similarity settings. Details:
`references/text-to-speech-guide.md`.

## Synthesis

Inspect the installed SDK/CLI and confirm an API key, voice IDs, model, and
format before a call; do not install both SDKs or assume a key exists. For long
scripts, split at natural boundaries and pass previous/next context for
stitching where the model supports it (not `eleven_v3`). For multi-speaker
files on v4/v3, use Text to Dialogue. For cloning, establish the speaker's consent and permitted use before upload.

Save and inspect the actual audio: spoken words, language, duration, format,
seams, and artifacts. A failed or unavailable call is reported as a limitation,
never as a generated file. `references/available-models.md` is a historical
excerpt, not a live inventory.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/elevenlabs-text-to-speech-generator.py` | Model-aware single-voice TTS: sends only settings the model supports, `--language-code`, `--previous-text`/`--next-text` |
| `scripts/elevenlabs-voice-manager.py` | List/manage voices |
| `scripts/elevenlabs-voice-cloner.py` | Voice cloning |
| `scripts/elevenlabs-sound-effects-generator.py` | Sound effects generation |

The scripts synthesize deterministically; writing and directing stay with the agent.

## Resources

- [API Docs](https://elevenlabs.io/docs)
- [Models](https://elevenlabs.io/docs/overview/models)
- [TTS best practices](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)
- [Text to Dialogue](https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue)
