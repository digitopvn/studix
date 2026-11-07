"""Tests for scripts/audit-ratio-scope.py and scripts/check-bounds.mjs.

Run: python -m pytest -q scripts/tests/test_audits.py
check-bounds tests need node and a resolvable playwright with Chromium; they skip otherwise.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
AUDIT = SCRIPTS / "audit-ratio-scope.py"
BOUNDS = SCRIPTS / "check-bounds.mjs"

MASTER = """<!doctype html>
<html data-ratio="16x9">
<head>
<style>
  .hl { font-size: 96px; color: #fff; }
  @media (min-width: 10px) {
    .card { top: 40px; }
  }
</style>
</head>
<body>
<div id="root"><div class="hl">Title</div></div>
<script>/*TIMING:BEGIN*/window.TIMING={};/*TIMING:END*/</script>
<script>
  const RATIO = document.documentElement.dataset.ratio;
  tl.to(".hl", { x: 10 }, 0);
</script>
</body>
</html>
"""


# ---------------------------------------------------------------- audit

def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    if not shutil.which("git"):
        pytest.skip("git not installed")
    proj = tmp_path / "master"
    proj.mkdir()
    git(proj, "init", "-q")
    git(proj, "config", "user.email", "t@example.invalid")
    git(proj, "config", "user.name", "t")
    git(proj, "config", "core.autocrlf", "false")
    (proj / "index.html").write_bytes(MASTER.encode())
    git(proj, "add", "-A")
    git(proj, "commit", "-qm", "master")
    return proj


def edit(proj, old, new):
    p = proj / "index.html"
    text = p.read_bytes().decode()
    assert old in text
    p.write_bytes(text.replace(old, new, 1).encode())


def audit(proj, *args):
    return subprocess.run([sys.executable, str(AUDIT), str(proj), *args], capture_output=True, text=True)


def test_clean_tree_passes(repo):
    r = audit(repo)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "0 violations" in r.stdout


def test_scoped_ratio_rule_passes(repo):
    edit(repo, "  @media", '  html[data-ratio="9x16"] .hl,\n  html[data-ratio="9x16"] .card {\n    font-size: 80px;\n  }\n  @media')
    edit(repo, "    .card { top: 40px; }", '    .card { top: 40px; }\n    html[data-ratio="9x16"] .card { top: 300px; }')
    r = audit(repo, "--ratio", "9x16")
    assert r.returncode == 0, r.stdout


def test_unscoped_rule_fails(repo):
    edit(repo, "  @media", "  .hl { letter-spacing: 1px; }\n  @media")
    r = audit(repo)
    assert r.returncode == 1
    assert "index.html:6 css-unscoped" in r.stdout
    assert "required step before commit" in r.stdout


def test_other_ratio_fails_when_ratio_is_pinned(repo):
    edit(repo, "  @media", '  html[data-ratio="1x1"] .hl { top: 1px; }\n  @media')
    assert audit(repo, "--ratio", "1x1").returncode == 0
    assert audit(repo, "--ratio", "9x16").returncode == 1
    edit(repo, "  @media", '  html[data-ratio="16x9"] .hl { top: 1px; }\n  @media')
    assert "css-unscoped" in audit(repo).stdout  # 16x9 is the master itself


def test_removed_master_declaration_fails(repo):
    edit(repo, "  .hl { font-size: 96px; color: #fff; }", "  .hl {\n    font-size: 96px;\n  }")
    r = audit(repo)
    assert r.returncode == 1
    assert "css-removed" in r.stdout


def test_removed_line_inside_media_block_fails(repo):
    edit(repo, "    .card { top: 40px; }\n", "")
    r = audit(repo)
    assert r.returncode == 1
    assert "css-removed" in r.stdout and "`.card`" in r.stdout


def test_comment_with_ratio_selector_does_not_scope(repo):
    edit(repo, "  @media", '  /* html[data-ratio="9x16"] */ .hl { top: 1px; }\n  @media')
    r = audit(repo)
    assert r.returncode == 1
    assert "css-unscoped" in r.stdout


def test_comment_only_change_passes(repo):
    edit(repo, "  @media", "  /* 9:16 overrides follow */\n  @media")
    assert audit(repo).returncode == 0


def test_crlf_only_change_passes(repo):
    p = repo / "index.html"
    p.write_bytes(p.read_bytes().replace(b"\n", b"\r\n"))
    r = audit(repo)
    assert r.returncode == 0, r.stdout


def test_ungated_js_fails_and_gated_passes(repo):
    anchor = '  tl.to(".hl", { x: 10 }, 0);'
    edit(repo, anchor, anchor + '\n  tl.to(".hl", { y: 40 }, 1);')
    r = audit(repo)
    assert r.returncode == 1
    assert "js-ungated" in r.stdout
    git(repo, "checkout", "--", "index.html")
    edit(repo, anchor, anchor + '\n  if (RATIO === "9x16") {\n    tl.to(".hl", { y: 40 }, 1);\n  }')
    r = audit(repo)
    assert r.returncode == 0, r.stdout


def test_timing_injection_is_ignored_and_markup_warns(repo):
    edit(repo, "window.TIMING={};", 'window.TIMING={"duration":12};')
    edit(repo, '<div class="hl">Title</div>', '<div class="hl">Title!</div>')
    r = audit(repo)
    assert r.returncode == 0, r.stdout
    assert "warning markup" in r.stdout
    assert audit(repo, "--strict").returncode == 1


def test_scene_fragments_and_new_files(repo):
    scenes = repo / "scenes"
    scenes.mkdir()
    frag = scenes / "s001.scene.html"
    frag.write_text('<section id="sc1" class="scene"><p>Hi</p></section>\n<style> #sc1 p { top: 2px; } </style>\n',
                    encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "scene")
    frag.write_text(frag.read_text() + '<style> html[data-ratio="9x16"] #sc1 p { top: 9px; } </style>\n', encoding="utf-8")
    assert audit(repo).returncode == 0
    (scenes / "s002.scene.html").write_text("<style> #sc2 p { top: 2px; } </style>\n", encoding="utf-8")
    r = audit(repo, "--json")
    report = json.loads(r.stdout)
    assert r.returncode == 1 and not report["ok"]
    assert {v["file"] for v in report["violations"]} == {"scenes/s002.scene.html"}


def test_before_after_pairs_without_git(tmp_path):
    before, after = tmp_path / "a.css", tmp_path / "b.css"
    before.write_text(".x { top: 1px; }\n", encoding="utf-8")
    after.write_text('.x { top: 1px; }\nhtml[data-ratio="9x16"] .x { top: 2px; }\n', encoding="utf-8")
    r = audit(tmp_path, "--before", before, "--after", after)
    assert r.returncode == 0, r.stdout
    after.write_text(".x { top: 3px; }\n", encoding="utf-8")
    assert audit(tmp_path, "--before", before, "--after", after).returncode == 1


def test_not_a_repo_is_a_clean_error(tmp_path):
    (tmp_path / "index.html").write_text(MASTER, encoding="utf-8")
    r = audit(tmp_path)
    assert r.returncode == 1
    assert r.stderr.startswith("error:") and "Traceback" not in r.stderr


# ---------------------------------------------------------------- check-bounds

def _playwright_ok():
    node = shutil.which("node")
    if not node:
        return False
    probe = "require(require.resolve('playwright'))"
    try:
        r = subprocess.run([node, "-e", probe], capture_output=True, timeout=30)
        if r.returncode == 0:
            return True
        root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True, timeout=30).stdout.strip()
        if root:
            env = dict(os.environ, NODE_PATH=root)
            return subprocess.run([node, "-e", probe], capture_output=True, timeout=30, env=env).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False
    return False


needs_playwright = pytest.mark.skipif(not _playwright_ok(), reason="node or playwright not available")

PAGE = """<!doctype html>
<html data-ratio="9x16">
<head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #000; }
  #root { position: relative; width: 1080px; height: 1920px; overflow: hidden; color: #fff; font-family: sans-serif; }
  .abs { position: absolute; }
</style></head>
<body>
<div id="root" data-composition-id="main" data-duration="3" data-width="1080" data-height="1920">
  <section id="sc01" class="scene">
    <div id="fine" class="abs" style="left: 200px; top: 600px; font-size: 48px">Stays put</div>
    <div id="ghost" class="abs" style="left: 10px; top: 10px; font-size: 48px; opacity: 0">Hidden outside</div>
    <div id="ignored" class="abs" data-bounds-ignore style="left: 0; top: 0; font-size: 48px">Ignored</div>
    __EXTRA__
  </section>
</div>
<script>
  (() => {
    const drifter = document.getElementById("drifter");
    let now = 0;
    window.__timelines = window.__timelines || {};
    window.__timelines["main"] = {
      duration() { return 3; },
      seek(t) {
        now = t;
        if (drifter) drifter.style.transform = `translateX(${Math.max(0, t - 1) * 100}px)`;
        return this;
      },
    };
  })();
</script>
</body>
</html>
"""
DRIFTER = '<div id="drifter" class="abs" data-bounds-box style="left: 700px; top: 800px; width: 300px; height: 80px"></div>'


def bounds(build, *args):
    env = dict(os.environ)
    if "NODE_PATH" not in env:
        root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True).stdout.strip()
        env["NODE_PATH"] = root
    return subprocess.run(["node", str(BOUNDS), str(build), *map(str, args)], capture_output=True, text=True,
                          timeout=90, cwd=build, env=env)


def make_build(tmp_path, extra):
    build = tmp_path / "build"
    build.mkdir()
    (build / "index.html").write_text(PAGE.replace("__EXTRA__", extra), encoding="utf-8")
    return build


@needs_playwright
def test_check_bounds_flags_drift(tmp_path):
    build = make_build(tmp_path, DRIFTER)
    r = bounds(build, "--step", "0.05", "--json")
    assert r.returncode == 1, r.stdout + r.stderr
    report = json.loads(r.stdout)
    drift = [v for v in report["violations"] if v["element"].endswith("#drifter") and v["kind"] == "content"]
    assert len(drift) == 1, report["violations"]
    v = drift[0]
    assert v["scene"] == "sc01" and "right" in v["detail"]
    assert 1.0 < v["from"] <= 1.15 and v["to"] == 3.0
    assert 185 <= v["worstPx"] <= 195  # 1000 + 200 - 1008
    assert not any(v["element"].endswith(("#fine", "#ghost", "#ignored")) for v in report["violations"])
    assert any(v["kind"] == "ends-unfinished" and v["element"].endswith("#drifter") for v in report["violations"])

    text = bounds(build)
    assert text.returncode == 1
    assert "#drifter" in text.stdout and "outside content area" in text.stdout and "t 1.10-3.00s" in text.stdout


@needs_playwright
def test_check_bounds_clean_page_passes(tmp_path):
    build = make_build(tmp_path, "")
    r = bounds(build, "--step", "0.25")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "check-bounds: OK" in r.stdout


@needs_playwright
def test_check_bounds_safe_override_and_font(tmp_path):
    build = make_build(tmp_path, '<div id="tiny" class="abs" style="left: 200px; top: 900px; font-size: 14px">tiny</div>')
    safe = tmp_path / "safe.json"
    safe.write_text(json.dumps({"minFont": 12}), encoding="utf-8")
    assert bounds(build, "--step", "0.5", "--safe", safe).returncode == 0
    r = bounds(build, "--step", "0.5")
    assert r.returncode == 1 and "#tiny" in r.stdout and "font below minimum" in r.stdout
