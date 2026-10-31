"""depth-maps without torch: the numeric helpers, and the clear UNAVAILABLE answer of the default image."""
from __future__ import annotations

import importlib.util

import numpy as np
import pytest

from conftest import run_tool
from studix_qa import depth_maps as dm


def test_normalise_spans_the_percentiles_and_keeps_a_flat_card_mid():
    d = np.linspace(0, 100, 1001, dtype=np.float32)
    n = dm.normalise(d)
    assert abs(float(np.percentile(n, 1))) < 1e-6
    assert abs(float(np.percentile(n, 99)) - 1) < 1e-6
    assert np.all(dm.normalise(np.full((4, 4), 3.0, np.float32)) == 0.5)


def test_model_size_scales_the_short_side_in_patch_multiples():
    assert dm.model_size(720, 1280, 518) == (518, 924)
    h, w = dm.model_size(1080, 1920, 1036)
    assert h % 14 == 0 and w % 14 == 0
    assert dm.grow_px((720, 1280)) == 5
    assert dm.grow_px((100, 100)) == 3


@pytest.mark.skipif(importlib.util.find_spec("torch") is not None, reason="torch is installed in this environment")
def test_default_image_reports_unavailable(tmp_path):
    img = tmp_path / "cel.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")
    response = run_tool("depth-maps", {"images": ["cel"]}, {"cel": img}, out_dir=tmp_path / "out")
    assert response["ok"] is False
    assert response["error"]["code"] == "UNAVAILABLE"
