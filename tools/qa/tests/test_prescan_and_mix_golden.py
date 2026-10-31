"""Golden tests for the prescan detectors and the mix-bus check.

Ported from zuey-workspace@10719856:.agents/skills/anime-creator/scripts/tests/test_delivery_and_mix_tools.py
(AuditAndPrescanTest). Same inputs and expectations; keys follow the tools' camelCase JSON.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from studix_qa import mix_buses as audit
from studix_qa import prescan as scan


def test_window_db_of_a_full_scale_square_is_zero():
    x = np.ones((4800, 2), np.float32)
    assert np.allclose(audit.window_db(x, 480), 0.0, atol=1e-6)


def test_gate_flags_buried_beds_and_thin_dialogue():
    st = {"beds": -30.0, "maskPct": 40.0, "bedsMinusMusic": -9.0, "voMinusBeds": 4.0}
    assert len(audit.gate(st, min_mask=60, max_under=6, min_vo=6)) == 3
    silent = {**st, "beds": -80.0, "maskPct": None, "bedsMinusMusic": None, "voMinusBeds": None}
    assert audit.gate(silent, min_mask=60, max_under=6, min_vo=6) == ["no bed"]


def test_wedge_needs_three_dark_blocks_from_a_corner():
    assert scan.wedge_run(np.array([-80, -90, -60, 0, 0])) == 3
    assert scan.wedge_run(np.array([0, -80, -90, -60, 0])) == 0
    g = np.full((720, 1280), 120, np.float32)
    g[0:3, 1280 - 64 * 5:] = 0  # top edge, five blocks from the right corner exposed
    assert scan.frame_wedges(g) == "T5"


def test_black_runs_and_inner_dropouts():
    assert scan.black_runs(np.array([2, 3, 50, 50, 1, 1, 1, 60])) == [(0, 2), (4, 7)]
    sr = 48000
    x = (0.1 * np.sin(np.arange(sr * 2) * 0.05)).astype(np.float32)
    x[sr // 2: sr // 2 + 4800] = 0  # 100 ms hole
    assert scan.dropouts(x, sr) == [(0.5, 0.6)]


def test_still_runs_flag_a_held_cel_but_not_a_move_or_black():
    fps, rng = 24, np.random.default_rng(1)
    base = np.full((4, 8), 120.0)
    frames = [base + rng.normal(0, 1, base.shape) for _ in range(72)]  # 3 s held under grain
    frames += [base + 20 * k for k in range(24)]  # 1 s of real change
    holds = scan.still_runs(frames, [120.0] * 96, fps, 1.5)
    assert len(holds) == 1
    assert holds[0][0] == 0.0
    assert holds[0][1] - holds[0][0] > 2.9
    assert scan.still_runs(frames, [5.0] * 96, fps, 1.5) == []  # black is the black check's job
    assert scan.still_runs(frames, [120.0] * 96, fps, 0) == []  # 0 turns the check off


def test_cut_frames_find_the_jump():
    f = np.full((20, 6, 8), 100.0)
    f += np.arange(20)[:, None, None] * 0.3  # a slow drift is not a cut
    f[12:] += 60
    assert scan.cut_frames(f) == [12]


def test_transient_onset_after_silence():
    sr = 24000
    x = np.zeros(sr, np.float32)
    x[int(0.25 * sr):int(0.3 * sr)] = 0.5
    pk, onset = scan.transient(x, sr)
    assert abs(pk - 20 * np.log10(0.5)) < 1e-3
    assert abs(onset - 0.25) < 0.01


def test_event_flags_bus_late_onset_and_null():
    f = Path("boom.wav")
    stubs = {"file_len": lambda _f: 2.0, "file_transient": lambda _f, _off, _ln: (-6.0, 0.4)}
    assert any("bus 'sfx'" in x for x in scan.event_flags({"bus": "sfx", "t": 1.0}, f, **stubs))
    assert any("late transient" in x for x in scan.event_flags({"bus": "hits", "t": 1.0}, f, **stubs))
    assert scan.event_flags({"bus": "hits", "t": 1.0, "onset": 0.4}, f, **stubs) == []
    assert scan.event_flags({"bus": "hits", "t": 1.0, "onset": None}, f, **stubs) == []
    assert any("onset key" in x for x in scan.event_flags({"bus": "hits", "onset": 0.1}, f, **stubs))
    assert any("inaudible" in x for x in scan.event_flags({"bus": "hits", "onset": 0.4, "gain": -30}, f, **stubs))
    assert scan.event_flags({"bus": "hits"}, None, **stubs)[0].startswith("missing")
