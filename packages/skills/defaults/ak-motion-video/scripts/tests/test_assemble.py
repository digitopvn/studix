"""Tests for scripts/assemble.py and scripts/scaffold-scenes.py.

Run: python -m pytest -q -p no:cacheprovider scripts/tests/test_assemble.py
"""
import importlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
SKELETON = SCRIPTS.parent / "assets/templates/index-skeleton.html"
sys.path.insert(0, str(SCRIPTS))
asm = importlib.import_module("assemble")
scaffold = importlib.import_module("scaffold-scenes")

FPS = 30
IDS = ["s01-cover", "s02-power-01", "s03-end"]
FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")


def timing():
    return {
        "duration": 12, "fps": FPS, "beat0": 0.5, "beatLen": 0.5, "kick": [[0, 8]], "drops": [8], "outroBeat": 20,
        "scenes": {
            "s01-cover": {"start": 0, "end": 4, "lines": [{"on": 0.5, "off": 3.2, "words": [["yo", 0.5, 0.8]]}]},
            "s02-power-01": {"start": 4, "end": 8, "lines": [{"on": 4.2, "off": 7.5, "words": [["power", 4.2, 4.6], ["offline", 5.0, 5.6]]}]},
            "s03-end": {"start": 8, "end": 12, "lines": [{"on": 8.3, "off": 11, "words": [["bye", 8.3, 8.7]]}]},
        },
        "captions": [
            {"start": 0.5, "end": 3.4, "words": [["Yo", 0.5]]},
            {"start": 3.5, "end": 4.6, "words": [["a", 3.6], ["b", 4.1]]},
            {"start": 4.7, "end": 7.9, "words": [["c</script>", 4.7]]},
            {"start": 8.3, "end": 11, "words": [["d", 8.3]]},
        ],
        "sfx": [{"sfx": "whoosh", "vol": 0.5, "t": 3.9}, {"sfx": "hit", "vol": 0.5, "t": 5.0}, {"sfx": "end", "vol": 0.5, "t": 9.0}],
        "env": [0.5] * (12 * FPS),
    }


def make_project(root, audio=False):
    proj = Path(root) / "demo"
    for d in ("data", "scenes", "assets/fonts", "assets/audio"):
        (proj / d).mkdir(parents=True)
    t = timing()
    html = SKELETON.read_text(encoding="utf-8").replace("window.TIMING=null;", f"window.TIMING={json.dumps(t)};")
    (proj / "index.html").write_text(html, encoding="utf-8")
    (proj / "hyperframes.json").write_text("{}", encoding="utf-8")
    (proj / "assets/fonts/a.ttf").write_bytes(b"font")
    script = {"scenes": [{"id": "s01-cover", "lines": [{"en": "Yo! Acme presents."}]},
                         {"id": "s02-power-01", "lines": [{"en": "Power one: offline."}]},
                         {"id": "s03-end", "mode": "recording", "title": "Bye <now>", "from": "g001", "to": "g002"}]}
    (proj / "data/script.json").write_text(json.dumps(script), encoding="utf-8")
    (proj / "data/timeline.json").write_text(json.dumps({k: v for k, v in t.items() if k != "env"}), encoding="utf-8")
    (proj / "data/vo-envelope.json").write_text(json.dumps([round(i / 1000, 3) for i in range(12 * FPS)]), encoding="utf-8")
    (proj / "scenes/s01-cover.scene.html").write_text(
        '<!-- cover -->\n<section id="sc01" class="scene layer" data-sid="s01-cover"><div class="hl">Cover</div></section>\n'
        "<style>#sc01 .hl { color: red; }</style>\n<script>pop(\"#sc01 .hl\", W(sid, \"yo\"));</script>\n", encoding="utf-8")
    (proj / "scenes/s02-power-01.scene.html").write_text(
        '<section id="sc02" class="scene layer"><section class="inner"><p>x</p></section><div>Power</div></section>\n'
        '<p>outside</p><section id="extra"></section>\n'
        "<style>#sc02 p { margin: 0; }</style>\n<style>html[data-ratio=\"9x16\"] #sc02 p { margin: 4px; }</style>\n"
        "<script>const n = 1;\npop(\"#sc02 div\", W(sid, \"offline\"));</script>\n", encoding="utf-8")
    (proj / "scenes/s03-end.html").write_text('<section id="sc03" class="scene layer"><div>End</div></section>\n', encoding="utf-8")
    (proj / "scenes/s03-end.css").write_text("#sc03 div { color: blue; }\n", encoding="utf-8")
    (proj / "scenes/s03-end.js").write_text("const s = \"</script>\"; // a literal close tag must not end the shell script\nrise(\"#sc03 div\", W(sid, \"bye\"));\n", encoding="utf-8")
    if audio:
        a = proj / "assets/audio"
        ff = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"]
        subprocess.run([*ff, "-i", "sine=frequency=440:duration=12:sample_rate=48000", "-ac", "1", str(a / "stem-voice.wav")], check=True)
        subprocess.run([*ff, "-i", "sine=frequency=220:duration=12:sample_rate=48000", "-ac", "2", str(a / "stem-music.wav")], check=True)
        subprocess.run([*ff, "-i", "sine=frequency=330:duration=12:sample_rate=48000", "-ac", "2", "-c:a", "aac", "-b:a", "128k", str(a / "mix.m4a")], check=True)
    return proj


def built_timing(out):
    html = (out / "index.html").read_text(encoding="utf-8")
    return json.loads(asm.TIMING_RE.search(html).group(1).replace("<\\/", "</")), html


def probe_duration(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(p.stdout.strip())


def test_full_build_splices_in_script_order(tmp_path):
    proj = make_project(tmp_path)
    out, line, warnings = asm.assemble(proj)
    assert out == proj / "builds/full"
    assert line == "builds/full: 3 scenes s01-cover..s03-end, 0.00–12.00 s, duration 12 s, ratio 16x9"
    t, html = built_timing(out)
    stage = html[html.index("<!--SCENES:BEGIN-->"):html.index("<!--SCENES:END-->")]
    assert [m for m in re.findall(r'<section id="(sc\d+)"', stage)] == ["sc01", "sc02", "sc03"]
    assert '<section class="inner"><p>x</p></section><div>Power</div></section>' in stage
    assert "outside" not in html and 'id="extra"' not in html and "Title here" not in html
    css = html[html.index("/*SCENE-CSS:BEGIN*/"):html.index("/*SCENE-CSS:END*/")]
    assert css.index("#sc01") < css.index("#sc02 p") < css.index('html[data-ratio="9x16"] #sc02') < css.index("#sc03 div")
    js = html[html.index("/*SCENE-JS:BEGIN*/"):html.index("/*SCENE-JS:END*/")]
    assert '/* s02-power-01 */ { const sid = "s02-power-01"; if (SC[sid]) {' in js
    assert js.index("s01-cover") < js.index("s02-power-01") < js.index('W(sid, "bye")')
    assert 'const s = "<\\/script>"' in js and "</script>" not in js
    assert t["scenes"] == timing()["scenes"] and t["duration"] == 12
    assert t["env"][:3] == [0, 0.001, 0.002] and len(t["env"]) == 12 * FPS
    assert 'data-duration="12"' in html
    saved = json.loads((out / "timeline.json").read_text(encoding="utf-8"))
    assert "env" not in saved and saved["beat0"] == 0.5
    assert (out / "hyperframes.json").is_file() and (out / asm.MARKER).is_file()
    assert os.stat(out / "assets/fonts/a.ttf").st_ino == os.stat(proj / "assets/fonts/a.ttf").st_ino
    assert warnings == []


def test_partial_range_rebases_timing(tmp_path):
    proj = make_project(tmp_path)
    (proj / "debug.html").write_text("<html></html>", encoding="utf-8")
    out, line, warnings = asm.assemble(proj, "s02..s03", title='Plan & "go" <b>')
    assert out == proj / "builds/s02..s03"
    assert line == "builds/s02..s03: 2 scenes s02-power-01..s03-end, 4.00–12.00 s, duration 8 s, ratio 16x9"
    assert any("debug.html" in w for w in warnings)
    t, html = built_timing(out)
    assert list(t["scenes"]) == ["s02-power-01", "s03-end"]
    assert t["scenes"]["s02-power-01"]["start"] == 0 and t["scenes"]["s03-end"]["start"] == 4
    assert t["scenes"]["s02-power-01"]["lines"][0]["words"][1] == ["offline", 1.0, 1.6]
    assert t["beat0"] == -3.5 and t["kick"] == [[0, 8]] and t["drops"] == [8] and t["outroBeat"] == 20
    assert t["captions"][0] == {"start": 0, "end": 0.6, "words": [["b", 0.1]]}
    assert [c["start"] for c in t["captions"]] == [0, 0.7, 4.3]
    assert [e["t"] for e in t["sfx"]] == [1.0, 5.0]
    assert t["env"][0] == 0.12 and len(t["env"]) == 8 * FPS
    assert 'id="sc01"' not in html and 'data-duration="8"' in html
    assert '<div id="hud-title" class="abs"><span>Plan &amp; &quot;go&quot; &lt;b&gt;</span></div>' in html


def test_tail_pads_envelope_and_duration(tmp_path):
    proj = make_project(tmp_path)
    out, line, _ = asm.assemble(proj, "s01-cover", tail=1.5, out=tmp_path / "short")
    t, _ = built_timing(out)
    assert t["duration"] == 5.5 and t["scenes"]["s01-cover"]["end"] == 4
    assert len(t["env"]) == int(5.5 * FPS) and t["env"][-1] == 0.164
    (proj / "data/vo-envelope.json").unlink()
    out, _, _ = asm.assemble(proj, "s03", tail=1.0, out=tmp_path / "short")
    t, _ = built_timing(out)
    assert len(t["env"]) == 5 * FPS and t["env"][0] == 0.5 and t["env"][-1] == 0
    assert line.startswith(str(tmp_path / "short") + ": 1 scenes s01-cover..s01-cover, 0.00–4.00 s, duration 5.5 s")


def test_ratio_nine_sixteen(tmp_path):
    proj = make_project(tmp_path)
    out, line, _ = asm.assemble(proj, "s01..s02", tag="short-01", ratio="9x16")
    html = (out / "index.html").read_text(encoding="utf-8")
    assert line.startswith("builds/short-01: 2 scenes") and line.endswith("ratio 9x16")
    assert 'data-width="1080" data-height="1920"' in html and 'data-ratio="9x16"' in html


def test_missing_fragments_exit_code(tmp_path, capsys):
    proj = make_project(tmp_path)
    (proj / "scenes/s01-cover.scene.html").unlink()
    (proj / "scenes/s03-end.html").unlink()
    assert asm.main([str(proj)]) == 1
    err = capsys.readouterr().err
    assert err.strip() == "error: missing scene fragments (scenes/<sid>.scene.html): s01-cover, s03-end"
    assert not (proj / "builds").exists()


def test_shell_without_markers_or_timing(tmp_path):
    proj = make_project(tmp_path)
    src = (proj / "index.html").read_text(encoding="utf-8")
    (proj / "index.html").write_text(src.replace("<!--SCENES:END-->", ""), encoding="utf-8")
    with pytest.raises(asm.AssembleError, match="SCENES:END"):
        asm.assemble(proj)
    (proj / "index.html").write_text(SKELETON.read_text(encoding="utf-8"), encoding="utf-8")
    with pytest.raises(asm.AssembleError, match="not injected"):
        asm.assemble(proj)


def test_refuses_foreign_directory_and_replaces_own(tmp_path):
    proj = make_project(tmp_path)
    foreign = proj / "builds/full"
    foreign.mkdir(parents=True)
    (foreign / "mine.txt").write_text("user data")
    with pytest.raises(asm.AssembleError, match="not made by assemble"):
        asm.assemble(proj)
    assert (foreign / "mine.txt").read_text() == "user data"
    out, _, _ = asm.assemble(proj, tag="p1")
    (out / "stale.txt").write_text("x")
    asm.assemble(proj, "s01..s02", tag="p1")
    assert not (out / "stale.txt").exists()
    other = make_project(tmp_path / "other")
    with pytest.raises(asm.AssembleError, match="is a build of"):
        asm.assemble(other, out=out)
    with pytest.raises(asm.AssembleError, match="plain directory name"):
        asm.assemble(proj, tag="../x")


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_assembled_scripts_parse(tmp_path):
    proj = make_project(tmp_path)
    out, _, _ = asm.assemble(proj, "s02..s03", ratio="1x1", title="x")
    html = (out / "index.html").read_text(encoding="utf-8")
    bodies = [m.group(1) for m in re.finditer(r"<script>([\s\S]*?)</script>", html)]
    assert len(bodies) == 2
    for i, body in enumerate(bodies):
        f = tmp_path / f"s{i}.js"
        f.write_text(body, encoding="utf-8")
        p = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
        assert p.returncode == 0, p.stderr
    skeleton = [m.group(1) for m in re.finditer(r"<script>([\s\S]*?)</script>", SKELETON.read_text(encoding="utf-8"))]
    f = tmp_path / "skeleton.js"
    f.write_text("\n".join(skeleton), encoding="utf-8")
    assert subprocess.run(["node", "--check", str(f)], capture_output=True).returncode == 0


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg not installed")
def test_audio_cut_with_stems_and_mix(tmp_path):
    proj = make_project(tmp_path, audio=True)
    master = proj / "assets/audio/mix.m4a"
    before = master.read_bytes()
    out, _, _ = asm.assemble(proj)  # full range, no tail: the mix stays a hard link
    assert os.stat(out / "assets/audio/mix.m4a").st_ino == os.stat(master).st_ino
    out, _, _ = asm.assemble(proj, "s02..s02", tail=1.0, tag="short")
    built = out / "assets/audio/mix.m4a"
    assert os.stat(built).st_ino != os.stat(master).st_ino and master.read_bytes() == before
    assert os.stat(out / "assets/audio/stem-voice.wav").st_ino == os.stat(proj / "assets/audio/stem-voice.wav").st_ino
    assert abs(probe_duration(built) - 5.0) < 0.1
    for stem in ("stem-voice.wav", "stem-music.wav"):
        (proj / "assets/audio" / stem).unlink()
    out, _, _ = asm.assemble(proj, "s03", tail=2.0, fade=0.5, tag="short")
    built = out / "assets/audio/mix.m4a"
    assert os.stat(built).st_ino != os.stat(master).st_ino and master.read_bytes() == before
    assert abs(probe_duration(built) - 6.0) < 0.1


def test_scaffold_creates_and_never_overwrites(tmp_path, capsys):
    proj = make_project(tmp_path)
    for f in (proj / "scenes").iterdir():
        f.unlink()
    (proj / "scenes/s02-power-01.scene.html").write_text("mine", encoding="utf-8")
    assert scaffold.main([str(proj)]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines == ["created scenes/s01-cover.scene.html", "skipped scenes/s02-power-01.scene.html (exists)", "created scenes/s03-end.scene.html"]
    assert (proj / "scenes/s02-power-01.scene.html").read_text(encoding="utf-8") == "mine"
    s1 = (proj / "scenes/s01-cover.scene.html").read_text(encoding="utf-8")
    assert '<section id="sc001" class="scene layer" data-sid="s01-cover">' in s1 and "Yo! Acme presents." in s1
    assert 'html[data-ratio="9x16"] #sc001 {}' in s1 and 'W(sid, "yo")' in s1
    s3 = (proj / "scenes/s03-end.scene.html").read_text(encoding="utf-8")
    assert 'id="sc003"' in s3 and "Bye &lt;now&gt;" in s3 and 'W(sid, "bye")' in s3
    section, css, js = asm.split_fragment(s3)
    assert section.startswith('<section id="sc003"') and "#sc003 .hl" in css and "pop(" in js
    assert scaffold.main([str(proj), "--scenes", "s01..s01"]) == 0
    assert capsys.readouterr().out.splitlines() == ["skipped scenes/s01-cover.scene.html (exists)"]


def test_scaffold_ids_without_numbers_and_no_timeline(tmp_path):
    proj = tmp_path / "p"
    (proj / "data").mkdir(parents=True)
    (proj / "data/script.json").write_text(json.dumps({"scenes": [{"id": "intro", "lines": [{"en": "Hello, world"}]}, {"id": "outro"}]}), encoding="utf-8")
    res = scaffold.scaffold(proj)
    assert [p.name for p, created in res if created] == ["intro.scene.html", "outro.scene.html"]
    intro = (proj / "scenes/intro.scene.html").read_text(encoding="utf-8")
    assert 'id="sc001"' in intro and 'W(sid, "hello")' in intro
    assert 'id="sc002"' in (proj / "scenes/outro.scene.html").read_text(encoding="utf-8")


def test_help_exits_zero():
    for script in ("assemble.py", "scaffold-scenes.py"):
        p = subprocess.run([sys.executable, str(SCRIPTS / script), "--help"], capture_output=True, text=True)
        assert p.returncode == 0 and "usage" in p.stdout.lower()
