"""Tests for the recording-mode back end: build-timeline.py, mix.py, finish.py, shorts.py.

Run: python -m pytest -q scripts/tests/test_recording_timeline.py
Synthetic media comes from ffmpeg (sine, testsrc2); everything is written to tmp_path.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[2]
REC = SKILL / "assets/templates/recording"

needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg/ffprobe not installed")

# Source take t1 (12 s): six spoken segments; the edit drops g003 (4.2-5.4 s).
WORDS = {
    "g001": [("Hello,", 0.2, 0.6), ("world", 0.7, 1.4)],
    "g002": [("This", 2.2, 2.5), ("is", 2.6, 2.8), ("the", 2.9, 3.0), ("plan.", 3.1, 3.4)],
    "g003": [("Cut", 4.2, 4.6), ("this", 4.7, 5.4)],
    "g004": [("Keep", 6.2, 6.6), ("going", 6.7, 7.4)],
    "g005": [(w, 8.2 + i * 0.1, 8.28 + i * 0.1) for i, w in enumerate("one two three four five six seven eight nine ten eleven twelve".split())],
    "g006": [("Bye", 10.2, 10.6), ("now!", 10.7, 11.4)],
}
EDL_MAP = {"duration": 8.8, "ranges": [
    {"take": "t1", "src": [0.1, 3.5], "dst": [0.0, 3.4], "speed": 1.0, "segments": ["g001", "g002"]},
    {"take": "t1", "src": [6.1, 11.5], "dst": [3.4, 8.8], "speed": 1.0, "segments": ["g004", "g005", "g006"]},
]}
SCRIPT = {"mode": "recording", "scenes": [
    {"id": "s001-hook", "from": "g001", "to": "g002"},
    {"id": "s002-body", "from": "g003", "to": "g004"},
    {"id": "s003-end", "from": "g005", "to": "g006"},
]}
VI = {"g005": "một hai ba bốn, năm sáu bảy tám chín mười mười một mười hai mười ba"}
HTML = """<!doctype html><html><body>
<div data-hf-id="x" id="root" data-composition-id="main" data-start="0" data-duration="60" data-width="1920" data-height="1080">
<audio id="mix" src="assets/audio/mix.m4a" data-start="0" data-duration="60"></audio></div>
<script>/*TIMING:BEGIN*/window.TIMING=null;/*TIMING:END*/</script></body></html>
"""


def ff(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def probe(path, entries, stream=None):
    argv = ["ffprobe", "-v", "error"] + (["-select_streams", stream] if stream else []) + ["-show_entries", entries, "-of", "default=nw=1:nk=1", str(path)]
    return subprocess.run(argv, capture_output=True, text=True, check=True).stdout.split()


def run(script, *args, check=True):
    proc = subprocess.run([sys.executable, "-X", "utf8", str(REC / script), *map(str, args)], capture_output=True, text=True, encoding="utf-8")
    if check:
        assert proc.returncode == 0, proc.stderr + proc.stdout
    return proc


def lufs(path):
    log = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True).stderr
    return float(re.search(r"I:\s+(-?[\d.]+) LUFS", log[log.rfind("Summary"):]).group(1))


def voice(path, seconds=8.8):
    # speech-like bursts: 1.4 s of tone, 0.6 s of silence
    ff("-f", "lavfi", "-i", f"aevalsrc='0.3*sin(2*PI*220*t)*lt(mod(t,2),1.4)':s=48000:d={seconds}", "-ac", "1", path)


def make_project(root, html=True):
    proj = Path(root) / "proj"
    (proj / "data").mkdir(parents=True)
    (proj / "assets/audio").mkdir(parents=True)
    segs = [{"id": gid, "take": "t1", "start": w[0][1], "end": w[-1][2], "text": " ".join(x[0] for x in w), "words": [list(x) for x in w]} for gid, w in WORDS.items()]
    for name, data in (("segments", segs), ("edl-map", EDL_MAP), ("script", SCRIPT), ("captions-vi", VI)):
        (proj / f"data/{name}.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    if html:
        (proj / "index.html").write_text(HTML, encoding="utf-8")
    return proj


def test_help_exits_zero():
    for script in ("build-timeline.py", "mix.py", "finish.py", "shorts.py"):
        assert run(script, "--help").returncode == 0


def test_timeline_without_envelope(tmp_path):
    proj = make_project(tmp_path)
    out = run("build-timeline.py", proj, "--no-env")
    tl = json.loads((proj / "data/timeline.json").read_text(encoding="utf-8"))
    assert list(tl) == ["duration", "fps", "beat0", "beatLen", "kick", "drops", "outroBeat", "scenes", "captions", "sfx", "mode"]
    assert tl["mode"] == "recording" and tl["duration"] == 8.8 and tl["fps"] == 30
    assert tl["kick"] == [] and tl["drops"] == [] and tl["outroBeat"] == 17
    sc = tl["scenes"]
    assert list(sc) == ["s001-hook", "s002-body", "s003-end"]
    # scene 1 starts at 0; s002 starts at g004's edited start (g003 is cut), s003 at g005's
    assert (sc["s001-hook"]["start"], sc["s001-hook"]["end"]) == (0, 3.5)
    assert (sc["s002-body"]["start"], sc["s002-body"]["end"]) == (3.5, 5.5)
    assert (sc["s003-end"]["start"], sc["s003-end"]["end"]) == (5.5, 8.8)
    assert sc["s001-hook"]["lines"][0] == {"on": 0.1, "off": 1.3, "words": [["hello", 0.1, 0.5], ["world", 0.6, 1.3]]}
    assert [w[0] for w in sc["s002-body"]["lines"][0]["words"]] == ["keep", "going"], "words of the cut segment are dropped"
    assert sc["s002-body"]["lines"][0]["on"] == 3.5
    assert len(sc["s003-end"]["lines"]) == 2
    for cap in tl["captions"]:
        assert 1 <= len(cap["words"]) <= 9 and cap["start"] <= cap["end"]
        assert all(isinstance(w[0], str) and isinstance(w[1], float) for w in cap["words"])
    vi = [c for c in tl["captions"] if c["words"][0][0] == "một"]
    assert len(vi) == 1 and vi[0]["words"][-1][0] == "bốn,", "long caption splits at punctuation"
    assert vi[0]["words"][0][1] == 5.5, "first Vietnamese word borrows the first spoken onset"
    assert all(c["end"] <= 8.8 for c in tl["captions"])
    assert tl["captions"][0]["words"] == [["Hello,", 0.1], ["world", 0.6]], "no translation: the spoken words caption"
    html = (proj / "index.html").read_text(encoding="utf-8")
    timing = json.loads(re.search(r"window\.TIMING=(.*?);/\*TIMING:END\*/", html).group(1))
    assert timing["scenes"] == tl["scenes"] and timing["env"] == []
    assert html.count('data-duration="8.8"') == 2 and 'data-duration="60"' not in html


def test_timeline_beat_snap_cues_and_warnings(tmp_path):
    proj = make_project(tmp_path, html=False)
    (proj / "data/music-arrangement.json").write_text(json.dumps({"bpm": 120, "beat0": 0.1}))
    (proj / "data/cues.json").write_text(json.dumps([{"sfx": "whoosh", "vol": 0.4, "t": 3.6}]))
    script = json.loads(json.dumps(SCRIPT))
    script["scenes"][1]["from"] = "g002"  # g002 is now referenced twice
    (proj / "data/script.json").write_text(json.dumps(script))
    out = run("build-timeline.py", proj, "--no-env")
    tl = json.loads((proj / "data/timeline.json").read_text(encoding="utf-8"))
    sc = tl["scenes"]
    assert sc["s002-body"]["start"] == 2.1, "g002 starts on a beat already"
    assert sc["s003-end"]["start"] == 5.6, "5.5 snaps to the beat at 5.6"
    assert sc["s002-body"]["end"] == 5.6
    assert tl["beat0"] == 0.1 and tl["beatLen"] == 0.5
    assert tl["sfx"] == [{"sfx": "whoosh", "vol": 0.4, "t": 3.6}]
    assert "g002 is referenced by s001-hook and s002-body" in out.stdout
    assert "index.html not found" in out.stdout


@needs_ffmpeg
def test_timeline_envelope_and_dry(tmp_path):
    proj = make_project(tmp_path)
    voice(proj / "assets/audio/voice.wav")
    dry = run("build-timeline.py", proj, "--dry")
    assert "s002-body" in dry.stdout and not (proj / "data/timeline.json").exists()
    run("build-timeline.py", proj)
    env = json.loads((proj / "data/vo-envelope.json").read_text())
    assert len(env) == 264 and max(env) == 1.0 and min(env) == 0.0
    assert env[10] > 0.5 and env[50] == 0.0, "tone at 0.33 s, silence at 1.67 s"
    html = (proj / "index.html").read_text(encoding="utf-8")
    assert '"env":[' in html and "window.TIMING=null" not in html


@needs_ffmpeg
@pytest.mark.parametrize("with_music", [False, True])
def test_mix(tmp_path, with_music):
    proj = make_project(tmp_path)
    voice(proj / "assets/audio/voice.wav")
    args = []
    if with_music:
        ff("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3", "-ac", "2", tmp_path / "bgm.wav")
        (proj / "data/music.json").write_text(json.dumps({"file": str(tmp_path / "bgm.wav"), "db": -22}))
    else:
        (proj / "assets/audio/stem-music.wav").write_bytes(b"stale")
    out = run("mix.py", proj, *args)
    mix = proj / "assets/audio/mix.m4a"
    assert abs(float(probe(mix, "format=duration")[0]) - 8.8) < 0.1
    assert probe(mix, "stream=codec_name,sample_rate,channels", "a") == ["aac", "48000", "2"]
    assert abs(lufs(mix) + 14) <= 1.0
    assert "LUFS" in out.stdout and "dBTP" in out.stdout
    assert (proj / "assets/audio/stem-voice.wav").exists()
    stem = proj / "assets/audio/stem-music.wav"
    assert stem.exists() == with_music
    if with_music:
        assert abs(float(probe(stem, "format=duration")[0]) - 10.8) < 0.1, "music stem keeps a 2 s tail"


@needs_ffmpeg
def test_finish_pip_and_audio_copy(tmp_path):
    proj = make_project(tmp_path)
    (proj / "assets/video").mkdir(parents=True)
    ff("-f", "lavfi", "-i", "testsrc2=size=640x480:rate=30:duration=6", "-pix_fmt", "yuv420p", proj / "assets/video/webcam.mp4")
    raw = tmp_path / "raw.mp4"
    ff("-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=3", "-pix_fmt", "yuv420p", raw)
    ff("-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=5", "-c:a", "aac", "-b:a", "192k", proj / "assets/audio/mix.m4a")
    out = tmp_path / "final.mp4"
    res = run("finish.py", proj, "--render", raw, "-o", out, "--from", "1.5", "--ring", "FFFFFF")
    assert "finish ->" in res.stdout
    assert probe(out, "stream=width,height", "v") == ["1920", "1080"]
    assert abs(float(probe(out, "format=duration")[0]) - 3.0) < 0.1
    assert probe(out, "stream=codec_name,pix_fmt,profile", "v") == ["h264", "High", "yuv420p"]
    src = probe(proj / "assets/audio/mix.m4a", "packet=size", "a")
    dst = probe(out, "packet=size", "a")
    assert len(dst) > 100 and dst == src[: len(dst)], "audio packets are copied untouched"
    nopip = tmp_path / "nopip.mp4"
    run("finish.py", proj, "--render", raw, "-o", nopip, "--no-pip")
    assert abs(float(probe(nopip, "format=duration")[0]) - 3.0) < 0.1
    bad = run("finish.py", proj, "--render", tmp_path / "missing.mp4", "-o", out, check=False)
    assert bad.returncode == 1 and bad.stderr.startswith("error: render not found")


def test_shorts_dry_run(tmp_path):
    proj = make_project(tmp_path)
    run("build-timeline.py", proj, "--no-env")
    (proj / "data/shorts.json").write_text(json.dumps([
        {"id": "01", "title": "The plan", "scenes": "s002..s003"},
        {"id": "02", "title": "Hook", "scenes": "s001-hook..s001-hook"},
    ]))
    built = run("shorts.py", proj, "build", "01", "--dry-run").stdout.strip().splitlines()
    assert len(built) == 1
    assert str(SKILL / "scripts/assemble.py") in built[0]
    assert built[0].endswith("--scenes s002..s003 --tag short-01 --ratio 9x16 --tail 1.2 --fade 1.2 --title 'The plan'")
    rendered = run("shorts.py", proj, "render", "--dry-run").stdout.strip().splitlines()
    assert len(rendered) == 4
    assert "hyperframes@0.8.77 render -q high -f 30 --strict -o" in rendered[0] and f"(cd {proj / 'builds/short-01'})" in rendered[0]
    assert "finish.py" in rendered[1] and "--ratio 9x16 --from 3.500" in rendered[1]
    assert str(proj / "builds/short-01/assets/audio/mix.m4a") in rendered[1] and rendered[1].endswith(str(proj / "renders/shorts/01.mp4"))
    assert "--from 0.000" in rendered[3]
    probed = run("shorts.py", proj, "probe", "02", "--dry-run").stdout.strip()
    assert "probe.py" in probed and probed.endswith("--expect 1080x1920 --fps 30 --loudness --black")
    (proj / "data/shorts.json").write_text(json.dumps([{"id": "03", "title": " ", "scenes": "s001..s002"}]))
    untitled = run("shorts.py", proj, "build", "--dry-run").stdout
    assert "--title" not in untitled, "an empty title would draw an empty HUD pill"
    assert "shorts.py" not in run("shorts.py", proj, "render", "--dry-run").stderr
    unknown = run("shorts.py", proj, "build", "99", check=False)
    assert unknown.returncode == 1 and "unknown short id" in unknown.stderr


REORDERED_MAP = {"duration": 8.8, "ranges": [
    {"take": "t1", "src": [6.1, 11.5], "dst": [0.0, 5.4], "speed": 1.0, "segments": ["g004", "g005", "g006"]},
    {"take": "t1", "src": [0.1, 3.5], "dst": [5.4, 8.8], "speed": 1.0, "segments": ["g001", "g002"]},
]}


def test_reordered_edl_needs_script_in_edl_order(tmp_path):
    proj = make_project(tmp_path)
    (proj / "data/edl-map.json").write_text(json.dumps(REORDERED_MAP))
    bad = run("build-timeline.py", proj, "--no-env", check=False)
    assert bad.returncode == 1 and "order the script scenes as the EDL keeps them" in bad.stderr
    assert not (proj / "data/timeline.json").exists(), "nothing is written for a misordered script"
    (proj / "data/script.json").write_text(json.dumps({"mode": "recording", "scenes": [
        {"id": "s002-body", "from": "g004", "to": "g004"},
        {"id": "s003-end", "from": "g005", "to": "g006"},
        {"id": "s001-hook", "from": "g001", "to": "g002"},
    ]}))
    run("build-timeline.py", proj, "--no-env")
    tl = json.loads((proj / "data/timeline.json").read_text(encoding="utf-8"))
    for sc in tl["scenes"].values():
        for line in sc["lines"]:
            assert sc["start"] - 0.26 <= line["on"] and line["off"] <= sc["end"] + 0.26
    starts = [c["start"] for c in tl["captions"]]
    assert starts == sorted(starts) and all(c["end"] > c["start"] for c in tl["captions"])


def test_caption_chunks_leave_no_orphan_word():
    import importlib.util
    sys.path.insert(0, str(REC))
    spec = importlib.util.spec_from_file_location("build_timeline", REC / "build-timeline.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    sizes = {n: [len(c) for c in mod.chunk([[f"w{i}", float(i)] for i in range(n)])] for n in (9, 10, 19)}
    assert sizes == {9: [9], 10: [5, 5], 19: [7, 6, 6]}


@needs_ffmpeg
def test_mix_never_rewrites_a_linked_file(tmp_path):
    proj = make_project(tmp_path)
    voice(proj / "assets/audio/voice.wav")
    run("mix.py", proj)
    mix = proj / "assets/audio/mix.m4a"
    linked = tmp_path / "build-mix.m4a"
    linked.hardlink_to(mix)  # what assemble.py does for a full build
    before = linked.read_bytes()
    voice(proj / "assets/audio/voice.wav", seconds=6.0)
    run("mix.py", proj)
    assert linked.read_bytes() == before, "the build keeps the mix it was assembled with"
    assert abs(float(probe(mix, "format=duration")[0]) - 6.0) < 0.1
    assert not list((proj / "assets/audio").glob(".*partial*"))
