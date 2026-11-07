"""Tests for the preflight and query CLIs: doctor, tl, validate, probe, contact-sheet.

Run: python -m pytest -q scripts/tests/test_preflight_cli.py
Media tests use ffmpeg-generated clips and skip when ffmpeg is missing.
"""
import json
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")


def cli(script, *args, cwd=None):
    proc = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPTS / script), *map(str, args)],
                          capture_output=True, text=True, encoding="utf-8", cwd=cwd, timeout=60)
    return proc.returncode, proc.stdout, proc.stderr


def scene(start, end, *words):
    return {"start": start, "end": end, "lines": [{"on": start, "off": end, "words": [list(w) for w in words]}]}


TIMELINE = {
    "duration": 6.0, "fps": 30,
    "scenes": {
        "s001-hook": scene(0.0, 2.0, ("plan", 0.2, 0.5), ("ahead", 0.6, 1.0), ("plan", 1.2, 1.6)),
        "s002-plan": scene(2.0, 4.0, ("ship", 2.1, 2.5), ("tiếng", 2.6, 3.0)),
        "s003-outro": scene(4.0, 6.0, ("bye", 4.2, 4.6)),
    },
    "captions": [],
}


@pytest.fixture
def project(tmp_path):
    data = tmp_path / "proj/data"
    data.mkdir(parents=True)
    (data / "timeline.json").write_text(json.dumps(TIMELINE, ensure_ascii=False), encoding="utf-8")
    (data / "parts.json").write_text(json.dumps([{"tag": "p1", "scenes": "s001..s002"},
                                                 {"tag": "p2", "scenes": "s003..s003"}]), encoding="utf-8")
    (data / "shorts.json").write_text(json.dumps([{"id": "01", "title": "Plan it", "scenes": "s002..s003"}]),
                                      encoding="utf-8")
    return data.parent


@pytest.fixture(scope="module")
def clip(tmp_path_factory):
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg/ffprobe not on PATH")
    out = tmp_path_factory.mktemp("media") / "clip.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=6",
                    "-f", "lavfi", "-i", "sine=f=440:r=48000:d=6", "-c:v", "libx264", "-preset", "ultrafast",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out)], check=True, timeout=60)
    return out


# ---------- tl.py ----------

def test_tl_list_shows_windows_and_parts(project):
    code, out, _ = cli("tl.py", project, "list")
    assert code == 0
    lines = out.splitlines()
    assert lines[0] == "s001-hook  0.00-2.00  2.00s  p1"
    assert lines[2].endswith("p2")
    assert lines[-1].startswith("3 scenes")


def test_tl_scene_by_prefix_with_part_window_and_neighbours(project):
    code, out, _ = cli("tl.py", project, "scene", "s002")
    assert code == 0
    assert out.startswith("s002-plan  2.00-4.00 (2.00s)  part p1 rel 2.00-4.00")
    assert "prev s001-hook 0.00-2.00 | next s003-outro 4.00-6.00" in out
    assert "L1 2.00-4.00: ship@2.10 tiếng@2.60" in out
    code, out, _ = cli("tl.py", project, "scene", "s003")
    assert "part p2 rel 0.00-2.00" in out


def test_tl_words_nth_and_relative_times(project):
    code, out, _ = cli("tl.py", project, "words", "s001", "^PLAN$")
    assert code == 0
    rows = out.splitlines()
    assert len(rows) == 2
    assert rows[1] == 'plan #2  1.20-1.60  rel 1.20  W("s001-hook","plan",2)'
    code, _, err = cli("tl.py", project, "words", "s001", "zzz")
    assert code == 1 and "no word" in err


def test_tl_short_and_part(project):
    code, out, _ = cli("tl.py", project, "short", "01")
    assert code == 0
    rows = out.splitlines()
    assert rows[0].startswith("short 01 2.00-6.00 (4.00s)  s002-plan..s003-outro (2 scenes)")
    assert '"Plan it"' in rows[0]
    assert rows[2] == "  s003-outro  rel 2.00-4.00  abs 4.00-6.00"
    code, out, _ = cli("tl.py", project, "part", "p1")
    assert code == 0 and out.startswith("part p1 0.00-4.00")


def test_tl_unknown_ids_name_near_matches(project):
    code, out, err = cli("tl.py", project, "scene", "s002-plam")
    assert code == 1 and out == ""
    assert "unknown scene 's002-plam'" in err and "s002-plan" in err
    assert "Traceback" not in err
    code, _, err = cli("tl.py", project, "scene", "s00")
    assert code == 1 and "ambiguous" in err
    code, _, err = cli("tl.py", project, "short", "99")
    assert code == 1 and "known: 01" in err


def test_tl_missing_timeline(tmp_path):
    code, _, err = cli("tl.py", tmp_path, "list")
    assert code == 1 and err.startswith("error: missing") and "Traceback" not in err


# ---------- validate.py ----------

FAKE_HF = textwrap.dedent("""\
    import sys
    step = sys.argv[-1]
    mode = open("mode.txt").read().strip()
    if mode == "fail" and step == "lint":
        print("  \\u2717 audio_src_not_found: missing assets/audio/mix.m4a")
        print("\\u25c7  1 error(s), 2 warning(s)")
        sys.exit(1)
    if mode == "silent":
        sys.exit(3)
    print("\\u25c7  0 error(s), 1 warning(s)" if step == "lint" else "Runtime\\n  0 errors, 0 warnings")
""")


def make_build(tmp_path, mode):
    build = tmp_path / "build"
    build.mkdir()
    (build / "index.html").write_text("<html></html>", encoding="utf-8")
    (build / "mode.txt").write_text(mode, encoding="utf-8")
    fake = tmp_path / "fake_hf.py"
    fake.write_text(FAKE_HF, encoding="utf-8")
    return build, f'"{sys.executable}" "{fake}"'


def test_validate_pass(tmp_path):
    build, hf = make_build(tmp_path, "pass")
    code, out, _ = cli("validate.py", build, "--hf-cmd", hf)
    assert code == 0, out
    assert out.strip() == f"validate {build}: lint 0/1 · check 0/0 · OK"
    assert (build / ".validate/lint.log").is_file() and (build / ".validate/check.log").is_file()


def test_validate_fail_shows_first_errors(tmp_path):
    build, hf = make_build(tmp_path, "fail")
    code, out, _ = cli("validate.py", build, "--hf-cmd", hf)
    assert code == 1
    assert out.splitlines()[0].endswith("lint 1/2 · check 0/0 · FAIL")
    assert "audio_src_not_found" in out
    code, out, _ = cli("validate.py", build, "--hf-cmd", hf, "--json")
    assert code == 1 and json.loads(out)["lint"]["errors"] == 1


def test_validate_uses_exit_code_without_counts(tmp_path):
    build, hf = make_build(tmp_path, "silent")
    code, out, _ = cli("validate.py", build, "--hf-cmd", hf)
    assert code == 1 and "lint 1/0 · check 1/0 · FAIL" in out


def test_validate_multiple_root_html_fails_fast(tmp_path):
    build, hf = make_build(tmp_path, "pass")
    (build / "old.html").write_text("<html></html>", encoding="utf-8")
    code, out, _ = cli("validate.py", build, "--hf-cmd", hf)
    assert code == 1
    assert "multiple root html: index.html, old.html" in out
    assert not (build / ".validate").exists(), "hyperframes must not run"


# ---------- probe.py ----------

@needs_ffmpeg
def test_probe_reports_and_flags_mismatch(clip, tmp_path):
    code, out, _ = cli("probe.py", clip, "--expect", "1920x1080", "--fps", "30")
    assert code == 0, out
    assert out.startswith(f"{clip}: 1920x1080 30fps 6.0")
    assert "h264" in out and "aac 48000Hz 1ch" in out
    code, out, _ = cli("probe.py", clip, "--expect", "1080x1920")
    assert code == 1 and "MISMATCH: size 1920x1080 != 1080x1920" in out


@needs_ffmpeg
def test_probe_missing_file_exits_2_after_the_rest(clip, tmp_path):
    missing = tmp_path / "nope.mp4"
    code, out, err = cli("probe.py", missing, clip, "--json")
    assert code == 2 and "Traceback" not in err
    rows = json.loads(out)
    assert rows[0]["status"] == "not rendered" and rows[1]["width"] == 1920
    code, out, _ = cli("probe.py", missing)
    assert code == 2 and out.strip() == f"{missing}: not rendered"


@needs_ffmpeg
def test_probe_loudness_and_black(clip):
    code, out, _ = cli("probe.py", clip, "--loudness", "--black", "--json")
    assert code == 0
    row = json.loads(out)[0]
    assert -30 < row["lufs"] < 0 and row["true_peak"] is not None
    assert row["black"] == []


# ---------- contact-sheet.py ----------

@needs_ffmpeg
def test_contact_sheet_width_capped(clip, tmp_path, project):
    out = tmp_path / "sheets"
    code, stdout, err = cli("contact-sheet.py", clip, "--timeline", project / "data/timeline.json",
                            "--scenes", "s001..s002", "--frames", "6", "--out", out)
    assert code == 0, err
    assert len(stdout.splitlines()) == 2
    for sid in ("s001-hook", "s002-plan"):
        sheet = out / f"sheet-{sid}.jpg"
        w = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width", "-of", "csv=p=0", str(sheet)],
                           capture_output=True, text=True, check=True).stdout.strip()
        assert int(w) <= 1400
        assert f"{sheet} {w}x" in stdout
    assert not (out / "sheet-s003-outro.jpg").exists()


@needs_ffmpeg
def test_contact_sheet_unrendered(tmp_path, project):
    code, _, err = cli("contact-sheet.py", tmp_path / "none.mp4", "--timeline", project / "data/timeline.json")
    assert code == 1 and "not rendered" in err


# ---------- doctor.py ----------

def test_doctor_writes_env_and_brief(project):
    code, out, err = cli("doctor.py", project, "--mode", "recording", "--skip-npx")
    env = json.loads((project / "data/env.json").read_text(encoding="utf-8"))
    assert env["shell"] in ("bash", "pwsh", "powershell")
    assert env["python"]["invoke"].endswith(" -X utf8")
    names = {c["name"] for c in env["checks"]}
    assert {"shell", "python", "python utf-8", "ffmpeg", "node", "npx", "hyperframes", "py:numpy"} <= names
    assert all(set(c) == {"name", "ok", "required", "detail"} for c in env["checks"])
    brief = out.strip().splitlines()[-1]
    assert brief == f"Shell: {env['shell']}. Python: `{env['python']['exe']} -X utf8`. " \
                    "Write files with Write/Edit, never heredocs."
    assert brief == env["brief"]
    failed_required = [c for c in env["checks"] if c["required"] and c["ok"] is False]
    assert code == (1 if failed_required else 0), err


def test_doctor_json_and_missing_project(tmp_path):
    code, out, _ = cli("doctor.py", "--json", "--skip-npx")
    assert json.loads(out)["brief"].startswith("Shell: ")
    code, _, err = cli("doctor.py", tmp_path / "missing", "--skip-npx")
    assert code == 1 and "project directory not found" in err


def test_every_cli_has_help():
    for script in ("doctor.py", "tl.py", "validate.py", "probe.py", "contact-sheet.py"):
        code, out, _ = cli(script, "--help")
        assert code == 0 and "usage" in out.lower(), script
