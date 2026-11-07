"""Tests for scripts/reframe.py (standard library only).

Run: python -m pytest scripts/tests/test_reframe.py
"""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
SKELETON = SCRIPTS.parent / "assets/templates/index-skeleton.html"
_spec = importlib.util.spec_from_file_location("reframe", SCRIPTS / "reframe.py")
rf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rf)


def make_project(root, html=None):
    proj = Path(root) / "demo"
    (proj / "assets/fonts").mkdir(parents=True)
    (proj / "assets/fonts/a.ttf").write_bytes(b"font")
    (proj / "hyperframes.json").write_text("{}", encoding="utf-8")
    src = html or SKELETON.read_text(encoding="utf-8").replace("window.TIMING=null;", "window.TIMING={};")
    (proj / "index.html").write_text(src, encoding="utf-8")
    return proj


class ReframeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_nine_sixteen_edition_from_skeleton(self):
        proj = make_project(self.tmp.name)
        out, files, warnings = rf.reframe(proj, "9x16")
        html = (out / "index.html").read_text(encoding="utf-8")
        self.assertEqual(out.name, "demo-9x16")
        self.assertIn('data-width="1080" data-height="1920"', html)
        self.assertIn('content="width=1080, height=1920"', html)
        self.assertIn('data-resolution="portrait" data-ratio="9x16"', html)
        self.assertIn("--W: 1080px; --H: 1920px;", html)
        self.assertEqual(html.count("data-ratio=\"16x9\""), 0)
        self.assertEqual((out / "assets/fonts/a.ttf").read_bytes(), b"font")
        self.assertEqual(files, 1)
        self.assertTrue((out / "hyperframes.json").is_file())
        self.assertEqual(json.loads((out / rf.MARKER).read_text())["ratio"], "9x16")
        self.assertEqual(warnings, [], "the skeleton is ratio-aware")

    def test_rerun_replaces_the_edition(self):
        proj = make_project(self.tmp.name)
        out, _, _ = rf.reframe(proj, "1x1")
        (out / "stale.txt").write_text("x")
        out, _, _ = rf.reframe(proj, "1x1")
        self.assertFalse((out / "stale.txt").exists())
        self.assertIn('data-width="1080" data-height="1080"', (out / "index.html").read_text(encoding="utf-8"))
        self.assertTrue((proj / "assets/fonts/a.ttf").is_file(), "the master keeps its assets")

    def test_refuses_foreign_directory_and_missing_timing(self):
        proj = make_project(self.tmp.name)
        (proj.parent / "demo-9x16").mkdir()
        (proj.parent / "demo-9x16/mine.txt").write_text("user data")
        with self.assertRaisesRegex(rf.ReframeError, "not made by reframe"):
            rf.reframe(proj, "9x16")
        self.assertTrue((proj.parent / "demo-9x16/mine.txt").is_file())
        with self.assertRaisesRegex(rf.ReframeError, "outside the master"):
            rf.reframe(proj, "1x1", proj / "sub")
        (proj / "index.html").write_text(SKELETON.read_text(encoding="utf-8"), encoding="utf-8")
        with self.assertRaisesRegex(rf.ReframeError, "TIMING"):
            rf.reframe(proj, "1x1", Path(self.tmp.name) / "other")

    def test_interrupted_run_can_be_rerun(self):
        proj = make_project(self.tmp.name)
        out = proj.parent / "demo-9x16"
        out.mkdir()
        (out / rf.MARKER).write_text(json.dumps({"master": str(proj.resolve()), "ratio": "9x16"}))
        out2, _, _ = rf.reframe(proj, "9x16")
        self.assertTrue((out2 / "index.html").is_file())

    def test_never_replaces_a_parent_or_another_masters_edition(self):
        proj = make_project(self.tmp.name)
        (proj.parent / rf.MARKER).write_text(json.dumps({"master": str(proj.resolve())}))
        with self.assertRaisesRegex(rf.ReframeError, "must not contain it"):
            rf.reframe(proj, "9x16", proj.parent)
        self.assertTrue((proj / "index.html").is_file(), "the master survives")
        other = Path(self.tmp.name) / "other-9x16"
        other.mkdir()
        (other / rf.MARKER).write_text(json.dumps({"master": str(Path(self.tmp.name) / "other")}))
        (other / "keep.mp4").write_text("x")
        with self.assertRaisesRegex(rf.ReframeError, "is an edition of"):
            rf.reframe(proj, "9x16", other)
        self.assertTrue((other / "keep.mp4").is_file())

    def test_bad_markers_fail_closed(self):
        proj = make_project(self.tmp.name)
        out = proj.parent / "demo-9x16"
        out.mkdir()
        (out / "keep.mp4").write_text("x")
        for marker, msg in (("{", "unreadable"), ("", "unreadable"), ("[1]", "names no master"), ("{}", "names no master")):
            (out / rf.MARKER).write_text(marker)
            with self.assertRaisesRegex(rf.ReframeError, msg):
                rf.reframe(proj, "9x16")
            self.assertTrue((out / "keep.mp4").is_file(), marker)

    def test_symlinked_folders(self):
        proj = make_project(self.tmp.name)
        (proj / "assets/images").mkdir()
        (proj / "assets/images/a.png").write_bytes(b"png")
        try:
            os.symlink(proj / "assets/images", proj / "assets/a_alias", target_is_directory=True)
            os.symlink(proj.parent, proj / "assets/up", target_is_directory=True)
        except OSError:
            self.skipTest("symlinks need extra privileges here")
        out, _, warnings = rf.reframe(proj, "9x16")
        self.assertTrue((out / "assets/images/a.png").is_file(), "the real folder is kept")
        self.assertTrue((out / "assets/a_alias/a.png").is_file(), "an alias is followed")
        self.assertFalse((out / "assets/up").exists(), "a link above the master is not walked")
        self.assertIn("skipped links", " ".join(warnings))

    def test_retry_after_a_half_finished_clear(self):
        proj = make_project(self.tmp.name)
        out, _, _ = rf.reframe(proj, "9x16")
        held = open(out / "assets/fonts/a.ttf", "rb")  # Windows cannot delete an open file
        try:
            try:
                rf.reframe(proj, "9x16")
            except OSError:
                pass
            self.assertTrue((out / rf.MARKER).is_file(), "the marker survives a failed clear")
        finally:
            held.close()
        rf.reframe(proj, "9x16")
        self.assertTrue((out / "index.html").is_file())
        (out / rf.MARKER).unlink()
        for child in list(out.iterdir()):
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        (out / (rf.MARKER + ".tmp")).write_text("")
        rf.reframe(proj, "9x16")  # a run killed before its marker landed is reclaimed
        self.assertTrue((out / rf.MARKER).is_file())

    def test_root_and_file_links(self):
        proj = make_project(self.tmp.name)
        ext = Path(self.tmp.name) / "ext"
        ext.mkdir()
        (ext / "logo.png").write_bytes(b"logo")
        try:
            os.symlink(Path(proj.anchor), proj / "assets/drive", target_is_directory=True)
            os.symlink(os.path.relpath(ext / "logo.png", proj / "assets"), proj / "assets/logo.png")
            os.symlink(ext / "missing.png", proj / "assets/broken.png")
        except OSError:
            self.skipTest("symlinks need extra privileges here")
        out, _, warnings = rf.reframe(proj, "9x16", Path(self.tmp.name) / "far/away/ed")
        self.assertFalse((out / "assets/drive").exists(), "a link to the drive root is not walked")
        self.assertEqual((out / "assets/logo.png").read_bytes(), b"logo")
        self.assertFalse((out / "assets/logo.png").is_symlink())
        self.assertFalse((out / "assets/broken.png").exists())
        self.assertIn("broken.png", " ".join(warnings))

    def test_non_utf8_master_is_a_clean_error(self):
        proj = make_project(self.tmp.name)
        (proj / "index.html").write_bytes("<html>".encode("utf-16"))
        with self.assertRaisesRegex(rf.ReframeError, "not UTF-8"):
            rf.reframe(proj, "9x16")

    def test_warns_on_a_fixed_16x9_layout(self):
        html = ('<html lang="en"><head><meta name="viewport" content="width=1920, height=1080">'
                "<style>#root { width: 1920px; }</style></head><body>\n"
                '<div id="root" data-width="1920" data-height="1080"></div>\n'
                "<script>window.TIMING={};</script></body></html>")
        proj = make_project(self.tmp.name, html)
        _, _, warnings = rf.reframe(proj, "9x16")
        text = " ".join(warnings)
        self.assertIn('no html[data-ratio="9x16"] rules', text)
        self.assertIn("--W/--H", text)
        self.assertIn("lines 1", text)

    def test_ratio_blocks_do_not_warn(self):
        src = SKELETON.read_text(encoding="utf-8").replace("window.TIMING=null;", "window.TIMING={};")
        rules = ('      html[data-ratio="9x16"] .card {\n        width: 1080px;\n        top: 540px;\n      }\n'
                 '      .wide { width: 1920px; }\n')
        proj = make_project(self.tmp.name, src.replace("    </style>", rules + "    </style>", 1))
        _, _, warnings = rf.reframe(proj, "9x16")
        self.assertEqual(len(warnings), 1, warnings)
        line = src.count("\n", 0, src.index("    </style>")) + 5
        self.assertIn(f"lines {line}", warnings[0], "only the unscoped 1920px rule is reported")

    def test_cli_reports_errors_cleanly(self):
        self.assertEqual(rf.main([str(Path(self.tmp.name) / "missing"), "--ratio", "1x1"]), 1)


if __name__ == "__main__":
    unittest.main()
