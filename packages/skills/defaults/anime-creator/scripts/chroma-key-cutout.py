#!/usr/bin/env python3
"""Chroma-key #00FF00 plates into RGBA cut-outs for cards and cels, and flag cut-offs at the frame edge.

usage: uv run --with opencv-python-headless --with numpy python chroma-key-cutout.py in.png [in2.png ...] --out-dir DIR
       [--crop] [--feather 1.0] [--lo 0.08] [--hi 0.42]
Per input: DIR/<name>.png (RGBA, despilled, 1 px choke, feathered, dark anime rim) and DIR/<name>.json
({src_w, src_h, box, edge_touch}) so the compositor can place the cut-out in its original pixel frame.
edge_touch lists the sides where opaque pixels reach the border: a figure that should be whole in frame
(arm, blade tip, foot) is cut there, so regenerate with a wider margin instead of shipping it.
Supported: macOS, Linux, Windows.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def key(src: Path, dst: Path, *, crop: bool, feather: float, lo: float, hi: float) -> dict:
    img = cv2.imread(str(src), cv2.IMREAD_COLOR).astype(np.float32) / 255.0
    b, g, r = img[..., 0], img[..., 1], img[..., 2]
    gk = g - np.maximum(r, b)  # greenness: how much green dominates the other channels
    alpha = 1.0 - np.clip((gk - lo) / (hi - lo), 0.0, 1.0)
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))  # isolated specks
    img[..., 1] = np.minimum(g, np.maximum(r, b) * 1.02)  # despill
    alpha = cv2.erode(alpha, np.ones((3, 3), np.uint8), iterations=1)  # choke the green fringe
    if feather > 0:
        alpha = cv2.GaussianBlur(alpha, (0, 0), feather)
    edge = np.clip(alpha * (1 - alpha) * 4, 0, 1)
    img *= (1 - 0.35 * edge)[..., None]  # anime cut-outs read better with a dark rim
    h, w = alpha.shape
    touch = [side for side, strip in (("left", alpha[:, :2]), ("right", alpha[:, -2:]), ("top", alpha[:2]), ("bottom", alpha[-2:]))
             if (strip > 0.1).mean() > 0.002]
    box = [0, 0, w, h]
    rgba = np.dstack([img, alpha])
    if crop:
        ys, xs = np.where(alpha > 0.02)
        x0, x1 = max(xs.min() - 4, 0), min(xs.max() + 5, w)
        y0, y1 = max(ys.min() - 4, 0), min(ys.max() + 5, h)
        rgba = rgba[y0:y1, x0:x1]
        box = [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]
    cv2.imwrite(str(dst), (np.clip(rgba, 0, 1) * 255).astype(np.uint8))
    meta = {"src_w": w, "src_h": h, "box": box, "edge_touch": touch}
    dst.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")
    return meta


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--crop", action="store_true")
    ap.add_argument("--feather", type=float, default=1.0)
    ap.add_argument("--lo", type=float, default=0.08)
    ap.add_argument("--hi", type=float, default=0.42)
    a = ap.parse_args()
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for f in map(Path, a.inputs):
        m = key(f, out / (f.stem + ".png"), crop=a.crop, feather=a.feather, lo=a.lo, hi=a.hi)
        warn = f"  EDGE TOUCH {','.join(m['edge_touch'])}: check for a cut limb or blade" if m["edge_touch"] else ""
        print(f"{f.name}: box {m['box']}{warn}")


if __name__ == "__main__":
    main()
