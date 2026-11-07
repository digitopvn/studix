"""Tests for the recording front end: transcribe, segments, apply-edl, check-edl.

Run: python -m pytest -q -p no:cacheprovider scripts/tests/test_recording_edl.py
"""
import importlib.util
import json
import math
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[2]
REC = SKILL / "assets/templates/recording"
HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")

TEXT = "Hello there. This is a test! We keep some words. Then we speed up. Finally we end."


def load(name):
    sys.path.insert(0, str(REC))
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), REC / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(script, *args, env=None):
    return subprocess.run([sys.executable, str(REC / f"{script}.py"), *map(str, args)], check=False, capture_output=True,
                          text=True, encoding="utf-8", env=env)


def whisper_words():
    words, t = [], 0.3
    for w in TEXT.split():
        words.append({"word": " " + w, "start": round(t, 2), "end": round(t + 0.3, 2)})
        t += 0.4 + (0.7 if w.endswith((".", "!")) else 0)
    return words


@pytest.fixture(scope="module")
def take(tmp_path_factory):
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg/ffprobe not on PATH")
    path = tmp_path_factory.mktemp("media") / "take1.mp4"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25",
                    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "12", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


@pytest.fixture
def project(tmp_path, take):
    proj = tmp_path / "proj"
    (proj / "raw").mkdir(parents=True)
    shutil.copy(take, proj / "raw/take1.mp4")
    (tmp_path / "take1.whisper.json").write_text(json.dumps({"language": "en", "segments": [{"words": whisper_words()}]}))
    res = run("transcribe", proj, "--engine", "whisper-json", "--import", tmp_path / "take1.whisper.json", "--take", "take1")
    assert res.returncode == 0, res.stderr
    res = run("segments", proj)
    assert res.returncode == 0, res.stderr
    return proj


def write_edl(proj, edl):
    (proj / "data/edl.json").write_text(json.dumps(edl), encoding="utf-8")


@needs_ffmpeg
def test_pipeline_cuts_audio_and_video_to_the_same_frames(project):
    transcript = json.loads((project / "data/transcript.json").read_text(encoding="utf-8"))
    assert transcript["engine"] == "whisper-json" and transcript["language"] == "en"
    assert transcript["takes"]["take1"]["path"] == "raw/take1.mp4"
    assert abs(transcript["takes"]["take1"]["duration"] - 12) < 0.1
    assert transcript["words"][0] == {"t": "Hello", "s": 0.3, "e": 0.6, "take": "take1"}

    segments = json.loads((project / "data/segments.json").read_text(encoding="utf-8"))
    assert [s["id"] for s in segments] == ["g001", "g002", "g003", "g004", "g005"]
    assert segments[1]["text"] == "This is a test!"
    assert segments[0]["words"][0] == ["Hello", 0.3, 0.6]

    write_edl(project, {"speed": 1.0, "pad": 0.08, "keep": [
        {"segments": "g001..g002"},
        {"segments": ["g004", "g005"], "speed": 1.25},
        {"take": "take1", "from": 10.5, "to": 11.5},
    ]})
    res = run("apply-edl", project)
    assert res.returncode == 0, res.stderr
    assert "saved" in res.stdout
    edl_map = json.loads((project / "data/edl-map.json").read_text(encoding="utf-8"))
    assert set(edl_map) == {"duration", "fps", "ranges"} and edl_map["fps"] == 30
    ranges = edl_map["ranges"]
    assert [r["segments"] for r in ranges] == [["g001", "g002"], ["g004", "g005"], []]
    assert [r["speed"] for r in ranges] == [1.0, 1.25, 1.0]
    assert ranges[0]["src"][0] == pytest.approx(0.22)
    cursor = 0.0
    for r in ranges:
        (a, b), (c, d) = r["src"], r["dst"]
        assert c == pytest.approx(cursor) and (d - c) == pytest.approx((b - a) / r["speed"], abs=1e-5)
        assert (d - c) * 30 == pytest.approx(round((d - c) * 30), abs=1e-4)
        cursor = d
    assert edl_map["duration"] == pytest.approx(cursor)

    res = run("check-edl", project)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "check-edl OK" in res.stdout and "webcam.mp4" in res.stdout
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=sample_rate,channels,duration_ts",
                            "-of", "json", str(project / "assets/audio/voice.wav")], capture_output=True, text=True, check=True)
    stream = json.loads(probe.stdout)["streams"][0]
    assert (stream["sample_rate"], stream["channels"]) == ("48000", 2)
    assert stream["duration_ts"] == round(edl_map["duration"] * 48000)

    # A map whose source window no longer matches its frame count drifts and must fail.
    ranges[1]["src"][1] += 0.1
    (project / "data/edl-map.json").write_text(json.dumps(edl_map), encoding="utf-8")
    res = run("check-edl", project)
    assert res.returncode == 1
    assert "drift reaches" in res.stderr and "check-edl FAIL" in res.stdout


@needs_ffmpeg
def test_apply_edl_rejects_a_segment_kept_twice(project):
    write_edl(project, {"keep": [{"segments": "g001..g003"}, {"segments": ["g002"]}]})
    res = run("apply-edl", project)
    assert res.returncode == 1
    assert res.stderr.strip() == "error: data/edl.json keep[2]: segment g002 is already kept by keep[1]"
    write_edl(project, {"keep": [{"segments": "g009"}]})
    assert "unknown segment 'g009'" in run("apply-edl", project).stderr


def test_segments_split_on_punctuation_gaps_words_and_takes():
    seg = load("segments")
    words = [{"t": t, "s": s, "e": s + 0.2, "take": take} for t, s, take in [
        ("Xin", 0.0, "a"), ("chào…", 0.3, "a"), ("một", 0.6, "a"), ("hai", 2.0, "a"),
        ("ba", 2.3, "a"), ("bốn", 2.6, "a"), ("năm", 2.9, "a"), ("sáu", 0.1, "b")]]
    out = seg.split_segments(words, max_gap=0.6, max_words=3)
    assert [s["text"] for s in out] == ["Xin chào…", "một", "hai ba bốn", "năm", "sáu"]
    assert [s["id"] for s in out] == ["g001", "g002", "g003", "g004", "g005"]
    assert out[4]["take"] == "b" and out[2]["start"] == 2.0 and out[2]["end"] == 2.8


def test_pads_stop_at_neighbours_and_touching_ranges_merge():
    edl = load("apply-edl")
    takes = {"a": {"duration": 10.0}}
    segments = [{"id": f"g00{i}", "take": "a", "start": s, "end": e} for i, (s, e) in
                enumerate([(0.02, 1.0), (1.1, 2.0), (2.5, 3.0), (3.05, 4.0)], 1)]
    pieces = edl.resolve_keep({"pad": 0.1, "keep": [{"segments": ["g001"]}, {"segments": "g002..g002"},
                                                     {"segments": "g004"}, {"segments": "g003", "speed": 1.5}]},
                              segments, takes)
    ranges = edl.pad_and_merge(pieces, takes)
    assert [(r["a"], r["b"], r["segments"]) for r in ranges] == [
        (0.0, pytest.approx(2.1), ["g001", "g002"]),
        (pytest.approx(3.025), pytest.approx(4.1), ["g004"]),
        (pytest.approx(2.4), pytest.approx(3.025), ["g003"]),
    ]
    frames = edl.quantise(ranges, takes)
    assert all(r["n"] == math.ceil((r["b"] - r["a"]) / r["speed"] * 30 - 1e-6) for r in ranges)
    assert frames == sum(r["n"] for r in ranges)


@pytest.mark.skipif(sys.platform == "win32", reason="the fake multix is a POSIX executable script")
def test_elevenlabs_engine_keeps_spoken_words_and_reuses_cached_json(tmp_path):
    proj = tmp_path / "proj"
    (proj / "raw").mkdir(parents=True)
    (proj / "raw/take2.wav").write_bytes(b"not audio")
    (proj / "raw/take10.wav").write_bytes(b"not audio")
    (proj / "raw/notes.txt").write_text("ignored")
    calls = tmp_path / "calls.log"
    scribe = {"language_code": "vie", "text": "Xin chào (cười) bạn.", "words": [
        {"text": "Xin", "start": 0.1, "end": 0.3, "type": "word", "speaker_id": "speaker_0"},
        {"text": " ", "start": 0.3, "end": 0.35, "type": "spacing"},
        {"text": "chào", "start": 0.35, "end": 0.6, "type": "word"},
        {"text": "(cười)", "start": 0.6, "end": 1.0, "type": "audio_event"},
        {"text": "bạn.", "start": 1.1, "end": 1.4, "type": "word"}]}
    canned = tmp_path / "scribe.json"
    canned.write_text(json.dumps(scribe, ensure_ascii=False), encoding="utf-8")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake = bindir / "multix"
    fake.write_text(f"""#!{sys.executable}
import os, shutil, sys
argv = sys.argv[1:]
with open({str(calls)!r}, "a", encoding="utf-8") as fh:
    fh.write(os.getcwd() + " " + " ".join(argv) + "\\n")
shutil.copy({str(canned)!r}, argv[argv.index("--output") + 1])
""", encoding="utf-8")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    env = {**os.environ, "PATH": f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}"}

    res = run("transcribe", proj, "--language", "vi", env=env)
    assert res.returncode == 0, res.stderr
    assert "take2: 3 words" in res.stdout
    data = json.loads((proj / "data/transcript.json").read_text(encoding="utf-8"))
    assert data["engine"] == "elevenlabs" and data["language"] == "vi"
    assert list(data["takes"]) == ["take2", "take10"]
    assert [w["t"] for w in data["words"]] == ["Xin", "chào", "bạn."] * 2
    assert [w["take"] for w in data["words"]] == ["take2"] * 3 + ["take10"] * 3
    log = calls.read_text(encoding="utf-8").splitlines()
    assert len(log) == 2
    assert all("--timestamps-granularity word --format json" in line and "--language vi" in line for line in log)
    assert not any(line.split(" ")[0] == str(proj) for line in log), "multix must not run in the project"
    assert (proj / "data/transcribe/take10.json").is_file()

    assert run("transcribe", proj, env=env).returncode == 0
    assert len(calls.read_text(encoding="utf-8").splitlines()) == 2, "cached takes are reused"
    assert run("transcribe", proj, "--force", env=env).returncode == 0
    assert len(calls.read_text(encoding="utf-8").splitlines()) == 4


def test_every_script_has_help():
    for name in ("transcribe", "segments", "apply-edl", "check-edl"):
        res = run(name, "--help")
        assert res.returncode == 0 and "usage:" in res.stdout, name


def test_example_data_files_parse():
    data = REC / "data"
    script = json.loads((data / "script.example.json").read_text(encoding="utf-8"))
    assert script["mode"] == "recording" and all({"id", "from", "to"} <= s.keys() for s in script["scenes"])
    edl = json.loads((data / "edl.example.json").read_text(encoding="utf-8"))
    assert edl["keep"] and "speed" in edl and "pad" in edl
    for name in ("captions-vi", "parts", "shorts"):
        assert json.loads((data / f"{name}.example.json").read_text(encoding="utf-8"))
