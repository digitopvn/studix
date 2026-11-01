"""speech-activity: how much of an audio file a voice activity detector hears as human speech (Silero VAD).

Generated sound effects can come back with a voice in them (the effect model reads a cue aloud, or a "no
voice" instruction itself prompts one), and a speech-to-text pass is no judge of that: it invents words on
clean wind and misses real ones. The detector is the signal. The worker decides what amount of speech counts
(`createSpeechProbe` in packages/qa); this tool only measures.

Needs the optional `speech` extra (silero-vad, which carries its model inside the wheel, so nothing is
downloaded at run time); the default image reports UNAVAILABLE. The first audio stream is decoded to 16 kHz
mono and run through the detector with its defaults. Result: `speechMs` is the summed length of the voiced
segments, `segments` lists them in seconds.
"""
from __future__ import annotations

from pathlib import Path

from .ff import decode_audio
from .sandbox import Deadline, Media, ToolError

SAMPLE_RATE = 16_000


def summarize(segments: list[dict], duration_s: float) -> dict:
    """Voiced time from the detector's `{start, end}` segments in seconds, clipped to the audio's length."""
    spans = [(max(0.0, float(s["start"])), min(duration_s, float(s["end"]))) for s in segments]
    spans = [(a, b) for a, b in spans if b > a]
    return {
        "durationMs": round(duration_s * 1000),
        "speechMs": round(sum(b - a for a, b in spans) * 1000),
        "segments": [{"startS": round(a, 3), "endS": round(b, 3)} for a, b in spans],
    }


def _load_vad():
    try:
        import torch  # noqa: PLC0415 - optional dependency
        from silero_vad import get_speech_timestamps, load_silero_vad  # noqa: PLC0415
    except ImportError as err:
        raise ToolError("UNAVAILABLE", "speech-activity needs the optional worker image with silero-vad",
                        {"extra": "speech"}) from err
    torch.set_num_threads(1)
    return torch, load_silero_vad(onnx=False), get_speech_timestamps


def run(payload: dict, media: Media, deadline: Deadline, _outputs) -> dict:
    path: Path = media.path(payload.get("media"))
    torch, model, get_speech_timestamps = _load_vad()
    samples = decode_audio(path, deadline, sr=SAMPLE_RATE)
    duration_s = len(samples) / SAMPLE_RATE
    if len(samples) == 0:
        return summarize([], 0.0)
    found = get_speech_timestamps(torch.from_numpy(samples.copy()), model, sampling_rate=SAMPLE_RATE, return_seconds=True)
    return summarize(found, duration_s)
