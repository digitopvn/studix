"""speech-activity: the arithmetic over detector segments, the clear UNAVAILABLE answer of the default image,
and, where the optional `speech` extra is installed, the real detector on sound that has no voice in it."""
from __future__ import annotations

import importlib.util
import os
import wave

import numpy as np
import pytest

from conftest import ffmpeg, run_tool
from studix_qa import speech_activity as sa

HAS_SILERO = importlib.util.find_spec("silero_vad") is not None
# CI runs this file with the `speech` extra and sets this, so a missing detector fails the build instead of
# skipping the two real-detector tests.
REQUIRE_SPEECH = os.environ.get("STUDIX_QA_REQUIRE_SPEECH") == "1"
needs_silero = pytest.mark.skipif(
    not HAS_SILERO and not REQUIRE_SPEECH, reason="needs the optional speech extra (silero-vad)")

SAMPLE_RATE = 16_000


def _vowel(f0: float, formants: list[tuple[int, int]], seconds: float) -> np.ndarray:
    """A glottal pulse train with vibrato, shaped by resonators at the formants and a syllable-rate envelope."""
    t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    phase = 2 * np.pi * np.cumsum(f0 * (1 + 0.05 * np.sin(2 * np.pi * 3 * t))) / SAMPLE_RATE
    source = sum(np.sin(k * phase) / k for k in range(1, 40))
    out = np.zeros_like(source)
    for centre, width in formants:
        r = np.exp(-np.pi * width / SAMPLE_RATE)
        a1, a2 = -2 * r * np.cos(2 * np.pi * centre / SAMPLE_RATE), r * r
        y = np.zeros_like(source)
        for n in range(len(source)):
            y[n] = (1 - r) * source[n] - a1 * (y[n - 1] if n > 0 else 0.0) - a2 * (y[n - 2] if n > 1 else 0.0)
        out += y
    return out * (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t) ** 2)


def _write_voice(path) -> None:
    """Three seconds of a vowel sequence (a, i, e, u, three times) between half a second of silence."""
    vowels = [[(700, 80), (1220, 90), (2600, 120)], [(300, 60), (2300, 90), (3000, 120)],
              [(500, 70), (1000, 80), (2500, 120)], [(300, 60), (870, 80), (2250, 120)]]
    gap = np.zeros(int(SAMPLE_RATE * 0.03))
    voice = np.concatenate([np.concatenate([_vowel(120, v, 0.22), gap]) for v in vowels * 3])
    pad = np.zeros(SAMPLE_RATE // 2)
    sig = np.concatenate([pad, voice, pad])
    sig = sig / np.abs(sig).max() * 0.7
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes((sig * 32767).astype("<i2").tobytes())


def test_summarize_sums_the_voiced_segments_in_milliseconds():
    out = sa.summarize([{"start": 0.0, "end": 1.9}, {"start": 4.3, "end": 5.0}], 5.0)
    assert out == {
        "durationMs": 5000,
        "speechMs": 2600,
        "segments": [{"startS": 0.0, "endS": 1.9}, {"startS": 4.3, "endS": 5.0}],
    }


def test_summarize_clips_segments_to_the_audio_and_drops_empty_ones():
    out = sa.summarize([{"start": -0.5, "end": 0.5}, {"start": 2.8, "end": 3.4}, {"start": 1.0, "end": 1.0}], 3.0)
    assert out["speechMs"] == 700
    assert out["segments"] == [{"startS": 0.0, "endS": 0.5}, {"startS": 2.8, "endS": 3.0}]


def test_no_segments_is_no_speech():
    assert sa.summarize([], 2.0) == {"durationMs": 2000, "speechMs": 0, "segments": []}


@pytest.mark.skipif(HAS_SILERO, reason="silero-vad is installed in this environment")
def test_default_image_reports_unavailable(tmp_path):
    clip = tmp_path / "fx.wav"
    clip.write_bytes(b"RIFF")
    response = run_tool("speech-activity", {"media": "fx"}, {"fx": clip}, out_dir=tmp_path / "out")
    assert response["ok"] is False
    assert response["error"]["code"] == "UNAVAILABLE"
    assert response["error"]["details"] == {"extra": "speech"}


@needs_silero
@pytest.mark.parametrize("source", [
    "anoisesrc=d=3:c=pink:a=0.3:r=44100",   # wind-like broadband noise
    "sine=f=440:d=2",                         # a held tone
])
def test_sound_without_a_voice_has_no_speech(ffmpeg_available, tmp_path, source):
    clip = tmp_path / "fx.wav"
    ffmpeg("-f", "lavfi", "-i", source, str(clip))
    response = run_tool("speech-activity", {"media": "fx"}, {"fx": clip}, out_dir=tmp_path / "out")
    assert response["ok"] is True, response
    assert response["result"]["speechMs"] == 0
    assert response["result"]["segments"] == []
    assert response["result"]["durationMs"] > 1500


@needs_silero
def test_a_voice_is_heard(tmp_path):
    clip = tmp_path / "voice.wav"
    _write_voice(clip)
    response = run_tool("speech-activity", {"media": "fx"}, {"fx": clip}, out_dir=tmp_path / "out")
    assert response["ok"] is True, response
    assert response["result"]["speechMs"] >= 1500
    assert response["result"]["segments"]
