#!/usr/bin/env python3
"""
ElevenLabs Text-to-Speech Generator (model-aware, deterministic).

Synthesizes an already-written script. It never writes or rewrites the script;
the agent does the writing and voice directing before calling this tool.

Only voice settings the selected model accepts are sent. A setting the model
does not accept is a usage error, not a silent drop. Settings that are not
passed are omitted so the voice's stored settings apply.

Usage:
    python elevenlabs-text-to-speech-generator.py "Hello world" -o output.mp3
    python elevenlabs-text-to-speech-generator.py -f script.txt -m eleven_v4 --stability 0.4
    python elevenlabs-text-to-speech-generator.py -f part2.txt --previous-text "End of part one."
    python elevenlabs-text-to-speech-generator.py "Bonjour" -m eleven_v4 --language-code fr

Environment:
    ELEVENLABS_API_KEY - Required API key
"""

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path

# Capability table for documented text-to-speech models. Provider support
# changes; verify live availability against the ElevenLabs models page. Keys:
#   settings  - voice_settings fields the model accepts
#   breaks    - whether SSML <break> tags are supported
#   language  - whether language_code is accepted
#   stitching - whether previous_text/next_text request stitching is supported
#   http      - whether the HTTP text-to-speech endpoint serves the model
_V2_SETTINGS = frozenset({"stability", "similarity_boost", "style", "speed", "use_speaker_boost"})
_V4_SETTINGS = frozenset({"stability", "similarity_boost"})


def _caps(settings, breaks, language=True, stitching=True, http=True):
    return {"settings": settings, "breaks": breaks, "language": language, "stitching": stitching, "http": http}


MODEL_CAPABILITIES = {
    "eleven_v4": _caps(_V4_SETTINGS, breaks=False),
    "eleven_v4_turbo": _caps(_V4_SETTINGS, breaks=False, http=False),
    "eleven_v3": _caps(_V2_SETTINGS, breaks=False, stitching=False),
    "eleven_multilingual_v2": _caps(_V2_SETTINGS, breaks=True, language=False),
    "eleven_flash_v2_5": _caps(_V2_SETTINGS, breaks=True),
    "eleven_flash_v2": _caps(_V2_SETTINGS, breaks=True),
    "eleven_turbo_v2_5": _caps(_V2_SETTINGS, breaks=True),
    "eleven_turbo_v2": _caps(_V2_SETTINGS, breaks=True),
}
DEFAULT_MODEL = "eleven_v4"

SETTING_FLAGS = {
    "stability": "--stability",
    "similarity_boost": "--similarity",
    "style": "--style",
    "speed": "--speed",
    "use_speaker_boost": "--speaker-boost/--no-speaker-boost",
}
_BREAK_TAG = re.compile(r"<\s*break\b", re.IGNORECASE)
_LANGUAGE_CODE = re.compile(r"^[a-z]{2,3}$")
_VOICE_ID = re.compile(r"^[A-Za-z0-9]{20}$")

# Fallback IDs for long-standing premade voices, used only when the account's
# voice list does not contain the requested name.
PREMADE_VOICE_IDS = {
    "rachel": "21m00Tcm4TlvDq8ikWAM", "drew": "29vD33N1CtxCmqQRPOHJ", "clyde": "2EiwWnXFnvU5JabPnv8n",
    "paul": "5Q0t7uMcjvnagumLfvZi", "domi": "AZnzlk1XvdvUeBnXmlld", "dave": "CYw3kZ02Hs0563khs1Fj",
    "fin": "D38z5RcWu1voky8WS1ja", "sarah": "EXAVITQu4vr4xnSDxMaL", "antoni": "ErXwobaYiN019PkySvjV",
    "thomas": "GBv7mTt0atIp3Br8iCZE", "charlie": "IKne3meq5aSn9XLyUdCD", "george": "JBFqnCBsd6RMkjVDRZzb",
    "emily": "LcfcDJNUP1GQjkzn1xUU", "elli": "MF3mGyEYCl7XYWbV9V6O", "callum": "N2lVS1w4EtoT3dr4eOWO",
    "patrick": "ODq5zmih8GrVes37Dizd", "harry": "SOYHLrjzK2X1ezoPC6cr", "liam": "TX3LPaxmHKxFdv7VOQHJ",
    "dorothy": "ThT5KcBeYPX3keUQqHPh", "josh": "TxGEqnHWrfWFTfGW9XjX", "arnold": "VR6AewLTigWG4xSOukaG",
    "charlotte": "XB0fDUnXU5powFXDhCwa", "alice": "Xb7hH8MSUJpSbSDYk0k2", "matilda": "XrExE9yKIg1WjnnlVkGX",
    "james": "ZQe5CZNOzWyzPSCn5a3c", "joseph": "Zlb1dXrM653N07WRdFW3", "jessica": "cgSgspJ2msm6clMCkdW9",
    "michael": "flq6f7yk4E4fJM5XTYuZ", "ethan": "g5CIjZEefAph4nQFvHAz", "chris": "iP95p4xoKVk53GoZ742B",
    "brian": "nPczCjzI2devNBz1zQrb", "daniel": "onwK4e9ZLuTAKqWW03F9", "lily": "pFZP5JQG7iQjIQuC4Bku",
    "bill": "pqHfZKP75CvOlQylNhV4", "grace": "oWAxZDx7w5VEj9dCyTzz", "adam": "pNInz6obpgDQGcFmaJgB",
    "nicole": "piTKgcLEGmPE4e6mEKli", "serena": "pMsXgVXv3BLzUgSXRplE",
}


class RequestError(ValueError):
    """The requested combination of model, settings and text is invalid."""


def load_env():
    """Load API key from environment or .env files."""
    if os.environ.get("ELEVENLABS_API_KEY"):
        return os.environ["ELEVENLABS_API_KEY"]

    env_paths = [
        Path.cwd() / ".claude" / ".env",
        Path.cwd() / ".claude" / "skills" / ".env",
        Path.cwd() / ".env",
        Path(__file__).parent / ".env",
        Path(__file__).parent.parent / ".env",
        Path.home() / ".claude" / "skills" / ".env",
        Path.home() / ".claude" / ".env",
    ]
    for env_path in env_paths:
        if env_path.exists():
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("ELEVENLABS_API_KEY="):
                        return line.split("=", 1)[1].strip().strip("\"'")
    return None


def requested_settings(args):
    """Collect only the voice settings the caller passed explicitly."""
    values = {
        "stability": args.stability,
        "similarity_boost": args.similarity,
        "style": args.style,
        "speed": args.speed,
        "use_speaker_boost": args.speaker_boost,
    }
    return {name: value for name, value in values.items() if value is not None}


def validate_settings(settings):
    """Range-check settings locally so obvious mistakes fail before a paid call."""
    for name in ("stability", "similarity_boost", "style"):
        if name in settings and not 0.0 <= settings[name] <= 1.0:
            raise RequestError(f"{SETTING_FLAGS[name]} must be between 0 and 1, got {settings[name]}")
    if "speed" in settings and settings["speed"] <= 0:
        raise RequestError(f"--speed must be positive, got {settings['speed']}")


def build_request(model, text, settings, language_code=None, previous_text=None,
                  next_text=None, text_normalization=None, output_format=None):
    """Return (kwargs for text_to_speech.convert minus voice_id, warnings).

    Raises RequestError when the request would send something the model does
    not support.
    """
    if not text or not text.strip():
        raise RequestError("text is empty")
    validate_settings(settings)
    warnings = []
    caps = MODEL_CAPABILITIES.get(model)

    if caps is None:
        warnings.append(
            f"model '{model}' is not in this script's capability table; sending only the "
            "settings you passed. Verify the model's supported settings on the provider models page."
        )
    else:
        if not caps["http"]:
            raise RequestError(
                f"{model} is served over the Text to Dialogue WebSocket, not the HTTP text-to-speech "
                "endpoint this script uses. Use eleven_v4 for file output, or stream eleven_v4_turbo "
                "from an application (see references/text-to-speech-guide.md)."
            )
        unsupported = sorted(set(settings) - caps["settings"])
        if unsupported:
            flags = ", ".join(SETTING_FLAGS[name] for name in unsupported)
            supported = ", ".join(SETTING_FLAGS[name] for name in sorted(caps["settings"]))
            hint = ""
            if caps["settings"] == _V4_SETTINGS:
                hint = " Direct pacing and emotion with audio tags and punctuation instead."
            raise RequestError(f"{model} does not support {flags}. Supported voice settings: {supported}.{hint}")
        if not caps["breaks"] and _BREAK_TAG.search(text):
            raise RequestError(
                f"{model} does not support SSML <break> tags. Use audio tags, ellipses, dashes "
                "and line breaks for pauses instead."
            )
        if language_code and not caps["language"]:
            raise RequestError(f"{model} does not accept --language-code; omit it for this model.")
        if (previous_text or next_text) and not caps["stitching"]:
            raise RequestError(
                f"{model} does not support request stitching; omit --previous-text/--next-text "
                "or use eleven_v4."
            )

    if language_code is not None and not _LANGUAGE_CODE.match(language_code):
        raise RequestError(f"--language-code must be a lowercase language code such as 'en', got '{language_code}'")

    request = {"text": text, "model_id": model}
    if settings:
        request["voice_settings"] = dict(settings)
    optional = {
        "language_code": language_code,
        "previous_text": previous_text,
        "next_text": next_text,
        "apply_text_normalization": text_normalization,
        "output_format": output_format,
    }
    request.update({key: value for key, value in optional.items() if value})
    return request, warnings


def resolve_voice_id(client, voice):
    """Accept a voice ID directly, otherwise match a voice name on the account."""
    if _VOICE_ID.match(voice):
        return voice
    voices = client.voices.get_all()
    for item in voices.voices:
        if item.name.lower() == voice.lower():
            return item.voice_id
    if voice.lower() in PREMADE_VOICE_IDS:
        return PREMADE_VOICE_IDS[voice.lower()]
    raise RequestError(f"voice '{voice}' not found on this account. Use --list-voices or pass a voice ID.")


def synthesize(client, voice_id, request, output, stream=False):
    """Call the provider and write audio atomically.

    Audio is streamed into a sibling temp file and moved over the output only
    on success, so a failed call never truncates or deletes an existing file.
    """
    tts = client.text_to_speech
    if stream:
        method = getattr(tts, "stream", None) or getattr(tts, "convert_as_stream")
    else:
        method = tts.convert
    output_path = Path(output)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{output_path.name}.", suffix=".part",
                                    dir=output_path.parent if str(output_path.parent) else None)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as f:
            for chunk in method(voice_id=voice_id, **request):
                f.write(chunk)
        if tmp_path.stat().st_size == 0:
            raise RuntimeError("provider returned no audio")
        # mkstemp creates owner-only files; give the output normal umask permissions.
        umask = os.umask(0)
        os.umask(umask)
        os.chmod(tmp_path, 0o666 & ~umask)
        os.replace(tmp_path, output_path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    return output_path


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Synthesize a finished script with ElevenLabs (model-aware)")
    parser.add_argument("text", nargs="?", help="Text to convert to speech")
    parser.add_argument("-f", "--file", help="Read text from a UTF-8 file instead")
    parser.add_argument("-o", "--output", default="output.mp3", help="Output file path")
    parser.add_argument("-v", "--voice", default="Rachel", help="Voice name or voice ID (default: Rachel)")
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help=f"Model ID (default: {DEFAULT_MODEL})")
    parser.add_argument("--stability", type=float, help="Stability 0-1 (all models)")
    parser.add_argument("--similarity", type=float, help="Similarity boost 0-1 (all models)")
    parser.add_argument("--style", type=float, help="Style exaggeration 0-1 (not Eleven v4)")
    parser.add_argument("--speed", type=float, help="Speed multiplier (not Eleven v4)")
    boost = parser.add_mutually_exclusive_group()
    boost.add_argument("--speaker-boost", dest="speaker_boost", action="store_true", default=None,
                       help="Enable speaker boost (not Eleven v4)")
    boost.add_argument("--no-speaker-boost", dest="speaker_boost", action="store_false",
                       help="Disable speaker boost (not Eleven v4)")
    parser.add_argument("--language-code", help="Language code to enforce, e.g. fr (not Multilingual v2)")
    parser.add_argument("--previous-text", help="Text spoken just before this chunk, for stitching (not Eleven v3)")
    parser.add_argument("--next-text", help="Text spoken just after this chunk, for stitching (not Eleven v3)")
    parser.add_argument("--text-normalization", choices=["auto", "on", "off"],
                        help="apply_text_normalization mode (provider default: auto)")
    parser.add_argument("--output-format", help="Provider output format, e.g. mp3_44100_128")
    parser.add_argument("--list-voices", action="store_true", help="List available voices")
    parser.add_argument("--stream", action="store_true", help="Use the HTTP streaming endpoint")
    return parser.parse_args(argv)


def read_text(args):
    if args.file:
        return Path(args.file).read_text(encoding="utf-8")
    if args.text:
        return args.text
    raise RequestError("provide text as an argument or use -f/--file")


def main(argv=None):
    args = parse_args(argv)
    request = None
    if not args.list_voices:
        try:
            request, warnings = build_request(
                args.model, read_text(args), requested_settings(args),
                language_code=args.language_code, previous_text=args.previous_text,
                next_text=args.next_text, text_normalization=args.text_normalization,
                output_format=args.output_format,
            )
        except (RequestError, OSError) as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2
        for warning in warnings:
            print(f"Warning: {warning}", file=sys.stderr)

    api_key = load_env()
    if not api_key:
        print("Error: ELEVENLABS_API_KEY not found in environment or .env files", file=sys.stderr)
        return 1
    try:
        from elevenlabs import ElevenLabs
    except ImportError:
        print("Error: elevenlabs package not installed. Run: pip install elevenlabs", file=sys.stderr)
        return 1

    client = ElevenLabs(api_key=api_key)
    try:
        if args.list_voices:
            print("Available voices:")
            for voice in client.voices.get_all().voices:
                print(f"  {voice.name} ({voice.voice_id})")
            return 0
        voice_id = resolve_voice_id(client, args.voice)
        print(f"Generating speech: voice={args.voice} ({voice_id}) model={args.model} "
              f"chars={len(request['text'])}")
        path = synthesize(client, voice_id, request, args.output, stream=args.stream)
    except RequestError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # provider/SDK/network failures surface as one explicit error
        print(f"Error: generation failed: {exc}", file=sys.stderr)
        return 1
    print(f"Audio saved to: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
