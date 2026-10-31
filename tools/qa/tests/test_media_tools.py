"""probe, black-frames, sync, prescan and mix-buses through the CLI, on lavfi media with known properties."""
from __future__ import annotations

from conftest import av_file, ffmpeg, result, tone, wav


def test_probe_reads_duration_fps_and_streams(tmp_path, ffmpeg_available):
    p = result("probe", {"media": "v"}, {"v": av_file(tmp_path / "a.mkv", audio=tone(0.282))})
    assert abs(p["durationS"] - 3.0) < 0.1
    assert p["video"]["fps"] == 24
    assert (p["video"]["width"], p["video"]["height"]) == (320, 180)
    assert p["audio"]["sampleRate"] == 48000
    assert p["audio"]["channels"] == 1


def test_black_frames_split_leading_inner_and_trailing(tmp_path, ffmpeg_available):
    clip = tmp_path / "b.mp4"
    # 0.5 s black, 1 s picture, 1 s black, 1 s picture, 0.5 s black at 24 fps.
    ffmpeg("-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=4",
           "-vf", "drawbox=c=black:t=fill:enable='lt(t,0.5)+between(t,1.5,2.4999)+gte(t,3.5)'",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip))
    b = result("black-frames", {"media": "v"}, {"v": clip})
    assert b["leadingS"] == 0.5
    assert b["maxInnerRunS"] == 1.0
    assert b["trailingS"] == 0.5
    assert b["allBlack"] is False


def test_all_black_clip(tmp_path, ffmpeg_available):
    clip = tmp_path / "k.mp4"
    ffmpeg("-f", "lavfi", "-i", "color=c=black:s=160x90:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip))
    b = result("black-frames", {"media": "v"}, {"v": clip})
    assert b["allBlack"] is True
    assert b["leadingS"] == 1.0


def test_sync_sees_a_muxed_audio_offset(tmp_path, ffmpeg_available):
    aligned = result("sync", {"media": "v"}, {"v": av_file(tmp_path / "ok.mkv", audio=tone(0.282))})
    assert abs(aligned["audioDelayMs"]) < 1
    assert abs(aligned["durationDeltaMs"]) < 50
    late = result("sync", {"media": "v"},
                  {"v": av_file(tmp_path / "late.mkv", audio=tone(0.282), audio_offset_s=0.25)})
    assert abs(late["audioDelayMs"] - 250) < 5


def test_sync_without_audio_is_a_validation_error(tmp_path, ffmpeg_available):
    from conftest import run_tool

    response = run_tool("sync", {"media": "v"}, {"v": av_file(tmp_path / "m.mkv", audio=None)})
    assert response["error"]["code"] == "VALIDATION"


def test_prescan_audio_flags_an_inner_dropout(tmp_path, ffmpeg_available):
    holed = wav(tmp_path / "d.wav", tone(0.1, 2.0, extra="*(1-between(t,0.5,0.6))"))
    p = result("prescan", {"mode": "audio", "media": ["a"]}, {"a": holed})
    assert any("dropout" in f for f in p["flags"])
    clean = result("prescan", {"mode": "audio", "media": ["a"]}, {"a": wav(tmp_path / "c.wav", tone(0.1, 2.0))})
    assert clean["flags"] == []


def test_prescan_picture_flags_a_long_leading_black(tmp_path, ffmpeg_available):
    clip = tmp_path / "p.mp4"
    ffmpeg("-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=2", "-vf", "drawbox=c=black:t=fill:enable='lt(t,1)'",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip))
    p = result("prescan", {"mode": "picture", "media": ["v"], "maxHoldS": 0}, {"v": clip})
    assert any("leading black" in f for f in p["flags"])
    assert p["files"][0]["frames"] == 48


def test_prescan_clips_ignore_a_cut_outside_the_used_range(tmp_path, ffmpeg_available):
    clip = tmp_path / "cut.mp4"
    ffmpeg("-f", "lavfi", "-i", "color=c=gray:s=320x180:r=24:d=2", "-vf", "drawbox=c=white:t=fill:enable='gte(t,1)'",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip))
    whole = result("prescan", {"mode": "clips", "media": ["c"]}, {"c": clip})
    assert any("internal cut at 1.00s" in f for f in whole["flags"])
    trimmed = result("prescan", {"mode": "clips", "media": ["c"], "ranges": {"c": [{"shot": "s1", "inS": 0, "outS": 0.9}]}},
                     {"c": clip})
    assert trimmed["flags"] == []


def test_prescan_events_report_an_unknown_bus_and_a_missing_file(tmp_path, ffmpeg_available):
    hit = wav(tmp_path / "hit.wav", tone(0.5, 0.5))
    p = result("prescan", {"mode": "events", "events": [{"bus": "sfx", "file": "hit", "t": 1.0},
                                                       {"bus": "hits", "file": "gone", "t": 2.0}]}, {"hit": hit})
    assert any("bus 'sfx'" in f for f in p["flags"])
    assert any(f.startswith("missing") for f in p["flags"])


def test_mix_buses_pass_a_bed_over_music_and_fail_a_buried_one(tmp_path, ffmpeg_available):
    beds = wav(tmp_path / "beds.wav", "anoisesrc=d=4:c=pink:r=48000:a=0.2", "-ac", "2")
    loud_music = wav(tmp_path / "music.wav", tone(0.9, 4.0), "-ac", "2")
    quiet_music = wav(tmp_path / "quiet.wav", tone(0.02, 4.0), "-ac", "2")
    shots = [{"id": "s1", "startS": 0, "endS": 4}]
    ok = result("mix-buses", {"stems": {"beds": "b", "music": "q"}, "shots": shots}, {"b": beds, "q": quiet_music})
    assert ok["pass"] is True
    buried = result("mix-buses", {"stems": {"beds": "b", "music": "m"}, "shots": shots}, {"b": beds, "m": loud_music})
    assert buried["pass"] is False
    assert any("under music" in f or "mask" in f for f in buried["fails"])
    silent = result("mix-buses", {"stems": {"music": "q"}, "shots": shots, "allow": []}, {"q": quiet_music})
    assert "s1: no bed" in silent["fails"]
