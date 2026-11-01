"""speech: how much of one audio file is human speech, measured by Silero VAD (a voice activity detector), for
the sound effects a generative model may have read aloud. Needs the optional `vad` extra (torch, silero-vad),
installed only in the optional worker image; the default image reports UNAVAILABLE.

The model ships inside the `silero-vad` wheel and runs on the CPU, so nothing is downloaded at run time. A
spectral heuristic cannot tell a short spoken word from a pitched noise, which is why this is a trained
detector and not a hard gate built on harmonics or syllable rate.

speechMs     total length of the segments the detector marks as speech
durationMs   length of the decoded audio
speechRatio  speechMs / durationMs (0 for empty audio)
segments     number of speech segments
"""
from __future__ import annotations

import numpy as np

from .ff import decode_audio
from .sandbox import Deadline, Media, ToolError

SAMPLE_RATE = 16000
# A spoken word is short ("No." is under half a second), so the default 250 ms floor would let it through.
MIN_SPEECH_MS = 100
THRESHOLD = 0.5


def summarise(segments: list[dict], total_samples: int) -> dict:
    """Totals from the detector's [{start, end}] sample ranges."""
    speech = sum(max(0, int(s["end"]) - int(s["start"])) for s in segments)
    return {
        "speechMs": round(speech * 1000 / SAMPLE_RATE, 1),
        "durationMs": round(total_samples * 1000 / SAMPLE_RATE, 1),
        "speechRatio": round(speech / total_samples, 4) if total_samples else 0.0,
        "segments": len(segments),
    }


def _load_detector():
    try:
        import torch  # noqa: PLC0415 - optional dependency
        from silero_vad import get_speech_timestamps, load_silero_vad  # noqa: PLC0415
    except ImportError as err:
        raise ToolError("UNAVAILABLE", "speech needs the optional worker image with silero-vad",
                        {"extra": "vad"}) from err
    torch.set_num_threads(1)
    return torch, load_silero_vad(onnx=False), get_speech_timestamps


def run(payload: dict, media: Media, deadline: Deadline, _outputs) -> dict:
    path = media.path(payload.get("media"))
    torch, model, get_speech_timestamps = _load_detector()
    samples = decode_audio(path, deadline, sr=SAMPLE_RATE, channels=1)
    if samples.size == 0:
        return summarise([], 0)
    segments = get_speech_timestamps(torch.from_numpy(samples.copy()), model,
                                     sampling_rate=SAMPLE_RATE, threshold=THRESHOLD,
                                     min_speech_duration_ms=MIN_SPEECH_MS)
    return summarise(segments, int(samples.size))
