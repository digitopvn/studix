"""Loudness and true peak on lavfi signals with known levels.

The summary parser is checked against the ebur128 output of the source's golden test (zuey-workspace@10719856:
.agents/skills/anime-creator/scripts/tests/test_delivery_and_mix_tools.py, test_parse_ebur128_summary). The
negative files (a true peak over -1.5 dBTP at -14 LUFS, and a mix 6 LU under target) are the measurements the
worker's hard gate blocks; packages/qa/test checks that it does.
"""
from __future__ import annotations

from conftest import av_file, result, run_tool, tone, wav
from studix_qa.loudness import parse_ebur128


def test_parse_ebur128_summary():
    err = ("[Parsed_ebur128_0 @ x] t: 1 TARGET:-23 LUFS M: -20.0 S: -20.0 I: -19.0 LUFS\n"
           "[Parsed_ebur128_0 @ x] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n"
           "    Threshold: -24.5 LUFS\n\n  Loudness range:\n    LRA:         3.1 LU\n\n  True peak:\n"
           "    Peak:       -1.8 dBFS\n")
    assert parse_ebur128(err) == {"integratedLufs": -14.2, "truePeakDbtp": -1.8, "lraLu": 3.1, "silent": False}


def test_parse_ebur128_silence_has_no_peak():
    err = "Summary:\n  Integrated loudness:\n    I:         -70.0 LUFS\n  True peak:\n    Peak:       -inf dBFS\n"
    parsed = parse_ebur128(err)
    assert parsed["truePeakDbtp"] is None
    assert parsed["silent"] is True


def test_on_target_tone(tmp_path, ffmpeg_available):
    m = result("loudness", {"media": "a"}, {"a": wav(tmp_path / "ok.wav", tone(0.282))})
    assert m["hasAudio"] is True
    assert abs(m["integratedLufs"] - -14.0) <= 0.3
    assert m["truePeakDbtp"] <= -1.5


def test_hot_peak_at_target_loudness_measures_over_the_ceiling(tmp_path, ffmpeg_available):
    # A 0.9 sample once a second, where the tone crosses zero, on top of the -14 LUFS tone: loudness barely
    # moves, the peak reaches about -0.9 dBFS.
    clicks = wav(tmp_path / "hot.wav", tone(0.282, extra="+0.9*eq(mod(n\\,48000)\\,0)"))
    m = result("loudness", {"media": "a"}, {"a": clicks})
    assert abs(m["integratedLufs"] - -14.0) <= 1.0
    assert m["truePeakDbtp"] > -1.5


def test_quiet_mix_measures_off_target(tmp_path, ffmpeg_available):
    m = result("loudness", {"media": "a"}, {"a": wav(tmp_path / "quiet.wav", tone(0.141))})
    assert abs(m["integratedLufs"] - -20.0) <= 0.3
    assert abs(m["integratedLufs"] - -14.0) > 1.0


def test_video_without_audio_reports_no_audio(tmp_path, ffmpeg_available):
    m = result("loudness", {"media": "v"}, {"v": av_file(tmp_path / "mute.mkv", audio=None)})
    assert m == {"hasAudio": False, "integratedLufs": None, "truePeakDbtp": None, "lraLu": None, "silent": True}


def test_digital_silence_is_silent(tmp_path, ffmpeg_available):
    m = result("loudness", {"media": "a"}, {"a": wav(tmp_path / "s.wav", "anullsrc=r=48000:cl=mono", "-t", "2")})
    assert m["silent"] is True
    assert m["truePeakDbtp"] is None


def test_ungranted_media_is_refused(tmp_path, ffmpeg_available):
    response = run_tool("loudness", {"media": "other"}, {"a": wav(tmp_path / "ok.wav", tone(0.282))})
    assert response["ok"] is False
    assert response["error"]["code"] == "VALIDATION"
