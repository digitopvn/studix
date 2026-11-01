"""speech: the totals of the detector's segments, the clear UNAVAILABLE answer of the default image, and (where
the optional `vad` extra is installed) a real detector run on clean noise."""
from __future__ import annotations

import importlib.util

import pytest

from conftest import run_tool, wav
from studix_qa import speech

HAS_VAD = importlib.util.find_spec("silero_vad") is not None


def test_summarise_totals_the_segments():
    out = speech.summarise([{"start": 0, "end": 8000}, {"start": 16000, "end": 20000}], 32000)
    assert out == {"speechMs": 750.0, "durationMs": 2000.0, "speechRatio": 0.375, "segments": 2}


def test_summarise_without_speech_or_samples():
    assert speech.summarise([], 16000)["speechRatio"] == 0.0
    assert speech.summarise([], 0) == {"speechMs": 0.0, "durationMs": 0.0, "speechRatio": 0.0, "segments": 0}


@pytest.mark.skipif(HAS_VAD, reason="silero-vad is installed in this environment")
def test_default_image_reports_unavailable(tmp_path, ffmpeg_available):
    clip = wav(tmp_path / "fx.wav", "anoisesrc=d=1:c=pink:r=24000:a=0.3")
    response = run_tool("speech", {"media": "fx"}, {"fx": clip})
    assert response["ok"] is False
    assert response["error"]["code"] == "UNAVAILABLE"


@pytest.mark.skipif(not HAS_VAD, reason="needs the optional vad extra")
def test_clean_noise_has_no_speech(tmp_path, ffmpeg_available):
    clip = wav(tmp_path / "wind.wav", "anoisesrc=d=2:c=pink:r=24000:a=0.3")
    response = run_tool("speech", {"media": "wind"}, {"wind": clip}, timeout_s=120)
    assert response["ok"], response
    assert response["result"]["speechRatio"] == 0.0
    assert response["result"]["segments"] == 0
    assert response["result"]["durationMs"] == pytest.approx(2000, abs=5)
