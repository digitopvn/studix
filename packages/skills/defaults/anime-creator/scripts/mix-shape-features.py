#!/usr/bin/env python3
"""Mix-shape numbers for a reference soundtrack and ours, side by side: how dense, bright, wide and dynamic each is.

usage: uv run --with numpy python -X utf8 mix-shape-features.py <file>[@start-end] [<file>[@start-end] ...] [--json out.json]
  e.g. mix-shape-features.py ref.wav@60-120 renders/sc03-master.mp4@0-58

Per span:
  floor    p10 - p50 of 0.4 s block loudness (dB): how far the bed sits under the body; near 0 = a wall of sound
  p90-p50  how far the peaks rise over the body (dB)
  spread   p90 - p10 (dB)
  bands    energy share (dB of total) below 120 Hz, 120-500, 500-2k, 2k-6k, 6k-12k
  onsets/s spectral-flux onsets per second: transient density
  side     side / mid energy (dB): stereo width; around -20 is near mono

These numbers are evidence, not the judge: they show *where* ours differs from a reference the user liked
(thinner lows, fewer transients, narrower), and the ear decides whether that difference matters.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402

SR = 24000
BANDS = [(0, 120), (120, 500), (500, 2000), (2000, 6000), (6000, 12000)]


def parse_spec(spec: str) -> tuple[str, float | None, float | None]:
    if "@" in spec:
        f, rng = spec.rsplit("@", 1)
        a, b = rng.split("-", 1)
        return f, float(a), float(b)
    return spec, None, None


def load(path: str, a: float | None = None, b: float | None = None) -> np.ndarray:
    cut = ["-ss", str(a), "-to", str(b)] if a is not None else []
    out = subprocess.run(io.resolve_cmd(["ffmpeg", "-nostdin", "-v", "error", *cut, "-i", path, "-ac", "2", "-ar", str(SR),
                                         "-f", "f32le", "-"]), capture_output=True, check=True).stdout
    return np.frombuffer(out, np.float32).reshape(-1, 2)


def features(x: np.ndarray, sr: int = SR) -> dict:
    m = x.mean(1)
    s = (x[:, 0] - x[:, 1]) / 2
    w = int(0.4 * sr)
    n = len(m) // w
    if n < 3:
        raise ValueError("span too short: need at least 1.2 s")
    blk = 10 * np.log10((m[:n * w].reshape(n, w) ** 2).mean(1) + 1e-12)
    act = blk[blk > blk.max() - 50]  # leave digital silence out of the statistics
    p10, p50, p90 = np.percentile(act, [10, 50, 90])
    hop, win = 512, 1024
    fr = np.lib.stride_tricks.sliding_window_view(m, win)[::hop] * np.hanning(win)
    spec = np.abs(np.fft.rfft(fr, axis=1))
    fq = np.fft.rfftfreq(win, 1 / sr)
    power = (spec ** 2).sum(0)
    tot = power.sum() + 1e-12
    share = [round(float(10 * np.log10(power[(fq >= lo) & (fq < hi)].sum() / tot + 1e-12)), 1) for lo, hi in BANDS]
    flux = np.maximum(np.diff(np.log1p(spec), axis=0), 0).sum(1)
    thr = np.median(flux) + 3 * flux.std()
    peaks = np.where((flux[1:-1] > thr) & (flux[1:-1] >= flux[:-2]) & (flux[1:-1] >= flux[2:]))[0]
    return {"dur": round(len(m) / sr, 2), "floor": round(float(p10 - p50), 1), "p90_p50": round(float(p90 - p50), 1),
            "spread": round(float(p90 - p10), 1), "bands": share, "onsets_s": round(len(peaks) / (len(m) / sr), 2),
            "side_db": round(float(10 * np.log10((s ** 2).mean() / ((m ** 2).mean() + 1e-12) + 1e-12)), 1)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("specs", nargs="+")
    ap.add_argument("--json")
    a = ap.parse_args()
    rows = []
    for spec in a.specs:
        f, s0, s1 = parse_spec(spec)
        d = {"file": f, "span": None if s0 is None else [s0, s1], **features(load(f, s0, s1))}
        rows.append(d)
        span = "" if s0 is None else f"{s0:g}-{s1:g}"
        print(f"{Path(f).name[:30]:30s} {span:10s} dur {d['dur']:6.1f}  floor {d['floor']:5.1f}  p90-p50 {d['p90_p50']:4.1f}  "
              f"spread {d['spread']:4.1f}  bands<120/500/2k/6k/12k {d['bands']}  onsets/s {d['onsets_s']}  side {d['side_db']}")
    if a.json:
        io.save_json(a.json, rows, indent=1)


if __name__ == "__main__":
    main()
