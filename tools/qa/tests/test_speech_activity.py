"""speech-activity: the arithmetic over detector segments, the clear UNAVAILABLE answer of the default image,
and, where the optional `speech` extra is installed, the real detector on sound that has no voice in it."""
from __future__ import annotations

import importlib.util

import pytest

from conftest import ffmpeg, run_tool
from studix_qa import speech_activity as sa

HAS_SILERO = importlib.util.find_spec("silero_vad") is not None


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


@pytest.mark.skipif(not HAS_SILERO, reason="needs the optional speech extra (silero-vad)")
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
