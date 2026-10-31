"""shot-boundaries through the CLI on a lavfi film with one continuous join and one hard pop."""
from __future__ import annotations

import numpy as np

from conftest import ffmpeg, result, run_tool
from studix_qa.shot_boundaries import join_metrics, judge

THR = {"luma": 18.0, "hist": 0.35, "ratio": 3.0, "chainedRatio": 4.5}


def film(path):
    """3 s at 24 fps: a moving test pattern for 2 s (a continuous cut at 1 s), then a white frame field."""
    ffmpeg("-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=2", "-f", "lavfi", "-i", "color=c=white:s=320x180:r=24:d=1",
           "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p",
           str(path))
    return path


def test_continuous_join_passes_and_a_lighting_pop_is_flagged(tmp_path, ffmpeg_available):
    joins = [
        {"a": "s1", "b": "s2", "atS": 1.0, "mode": "camera-transition"},
        {"a": "s2", "b": "s3", "atS": 2.0, "mode": "locked-composition"},
    ]
    r = result("shot-boundaries", {"media": "v", "joins": joins}, {"v": film(tmp_path / "f.mp4")})
    first, second = r["joins"]
    assert first["verdict"] == "ok", first
    assert second["verdict"] == "flag"
    assert any(w.startswith("luma") for w in second["why"])
    assert r["flagged"] == 1 and r["pass"] is False


def test_an_intentional_cut_is_allowed(tmp_path, ffmpeg_available):
    joins = [{"a": "s2", "b": "s3", "atS": 2.0, "mode": "intentional-cut"}]
    r = result("shot-boundaries", {"media": "v", "joins": joins}, {"v": film(tmp_path / "f.mp4")})
    assert r["joins"][0]["verdict"] == "allowed"
    assert r["pass"] is True


def test_rejects_joins_without_a_mode(tmp_path, ffmpeg_available):
    response = run_tool("shot-boundaries", {"media": "v", "joins": [{"a": "x", "b": "y", "atS": 1}]},
                        {"v": film(tmp_path / "f.mp4")})
    assert response["error"]["code"] == "VALIDATION"


def test_chained_join_is_judged_on_the_looser_ratio():
    rng = np.random.default_rng(1)
    a = rng.uniform(100, 110, (4, 90, 160, 3)).astype(np.float32)
    b = a[-1:] + 40.0  # redrawn still: same picture, offset
    m = join_metrics(a, b)
    assert m["ratio"] > THR["ratio"]
    m = {**m, "ratio": 4.0}
    assert judge(m, "camera-transition", THR)[0] == "flag"
    assert judge({**m, "luma": 0, "hist": 0}, "camera-transition", THR, chained=True)[0] == "ok"
